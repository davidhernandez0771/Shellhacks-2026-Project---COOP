"""COOPER's CAD assembly → the showcase site's web model (site/models/cooper-camera.glb).

Runs inside Blender (tested with 4.2), headless, from the repo root:

    blender -b -P tools/cad_to_glb.py -- --src "Assembled Pi Case.fbx"
    blender -b -P tools/cad_to_glb.py -- --src "Assembled Pi Case.fbx" --preview preview.png

The source is the Fusion 360 export of the assembled case (FBX, because it keeps the
component names; the OBJ export loses them). The CAD files are not in the repo.

What it does:
  1. imports the FBX (Fusion writes metres here: the case is 92 mm wide) and sorts every
     body into a part by its Fusion component (PARTS, LOOSE);
  2. simplifies each part for the web: coincident vertices merged, flat faces dissolved
     into single polygons (so they stay flat), then an edge collapse down to the part's
     triangle budget. The Pi board is handled per component (PI_RULES): the board and
     the ports are kept and decimated, chips become boxes, tiny parts are dropped, and
     the GPIO header is rebuilt as 40 square pins on a spacer;
  3. turns the assembly so the lens looks down glTF -Z with +Y up, the origin at the centre
     of the case's bottom face, and each part's origin at the centre of its bounds;
  4. adds the red LED as an instance of the yellow one, in the lid's empty hole;
  5. exports a .glb with one named node per part, one material per part, no normals (the
     site draws unlit fills and computes its edges from positions), no textures, no Draco.

--preview renders the grouping, each part in its own colour, and stops.
"""
import argparse
import math
import sys

import bmesh
import bpy
import mathutils

# node name → (Fusion component whose bodies belong to it, triangle budget)
PARTS = {
    "Pi_Case": ("Pi_Case v2", None),          # simple shells: dissolving the flat faces is
    "Pi_Case_Lid": (None, None),               # enough (~4.5k, ~3k); a collapse would tear them
    "RASPBERRY_PI_5_1": ("RASPBERRY_PI_5_1 v3", None),   # budgeted per component, PI_RULES
    "Camera_Mount": ("Camera Mount v2", None),
    "Camera_Module": ("Camera Module Assem v5", None),   # budgeted per component, CAM_RULES
    "LED5mm_Yellow": ("LED5mm v1", 600),
}
# the two bodies outside any component: the lid, and the small LED holder under it
LOOSE = {"Body2.026": "Pi_Case_Lid", "Body3.023": "Pi_Case_Lid"}

# Pi 5 sub-components (name without the ":n" suffix): a triangle budget to keep and
# decimate, "box" for its bounding box, "pins" for the rebuilt GPIO header, or "drop"
PI_RULES = {
    "PLATE_RASPBERRY_PI_5": 2000,
    "2xUSB_2.0_PORT": 1400,
    "2xUSB_3.0_PORT": 1400,
    "GIGABIT_ETHERNET_PORT": "box",            # a collapse turns its opening into spikes
    "FEMALE_MICRO_HDMI_CONNECTOR": "box",
    "FEMALE_USB_CONNECTOR": "box",
    "3.0_PIN_HEADER_10": "pins",
    "BROADCOM_1": "box", "RP1_CO_CONTROLLER": "box", "GIGABIT_ETHERNET_TRANSCEIVER": "box",
    "MxL": "box", "9FD77_D9WHV": "box", "SLOT_CARD_ASM": "box", "CAMERA_DISPLAY_1": "box",
    "CAMERA_DISPLAY_2": "box", "METAL_PLATE.": "box", "2.0_PIN_HEADER": "box",
    "BUTTON_2": "box", "STOCK_1": "box", "STOCK_2": "box", "STOCK_3": "box",
    "Logo raspberry": "drop", "CONNECT_V1": "drop", "BUTTON_MINI": "drop",
}
CAM_RULES = {
    "Lenz": 900,
    "Camera end": 4500,
    "Camera Block": 900,
    "PCB 1": 800,
    "15 Pin Ribbon Block Assem": "box",
    "0603 Resistor": "drop",
}

# Fusion frame (after the FBX import): the lens looks down +X and the lid faces -Y, so -Y
# is up. The glTF exporter writes Blender (x, y, z) as glTF (x, z, -y): glTF -Z is Blender
# +Y and glTF +Y is Blender +Z. So: CAD +X → +Y, CAD -Y → +Z, and x = y × z = CAD -Z.
CAD_TO_BLENDER = mathutils.Matrix(((0, 0, -1), (1, 0, 0), (0, -1, 0))).to_4x4()

PREVIEW_COLORS = {
    "Pi_Case": (0.55, 0.55, 0.58),
    "Pi_Case_Lid": (0.85, 0.85, 0.88),
    "RASPBERRY_PI_5_1": (0.15, 0.6, 0.25),
    "Camera_Mount": (0.2, 0.4, 0.9),
    "Camera_Module": (0.95, 0.45, 0.1),
    "LED5mm_Yellow": (0.95, 0.85, 0.1),
    "LED5mm_Red": (0.9, 0.1, 0.1),
}


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser(prog="cad_to_glb")
    p.add_argument("--src", required=True, help="the Fusion 360 FBX export")
    p.add_argument("--out", default="site/models/cooper-camera.glb")
    p.add_argument("--preview", help="render the parts to <name>_<view>.png and stop")
    return p.parse_args(argv)


# ───────────────────────── grouping ─────────────────────────
def ancestors(obj):
    a = obj.parent
    while a is not None:
        yield a
        a = a.parent


def part_of(obj):
    if obj.name in LOOSE:
        return LOOSE[obj.name]
    for a in ancestors(obj):
        for name, (comp, _) in PARTS.items():
            if comp and a.name == comp:
                return name
    return None


def component_of(obj, root):
    """The sub-component occurrence of `root` that obj belongs to ("CAMERA_DISPLAY_2:2")."""
    prev = obj
    for a in ancestors(obj):
        if a.name == root:
            return prev.name
        prev = a
    return obj.name


def import_and_group(src):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=src)
    groups = {name: [] for name in PARTS}
    stray = []
    for o in bpy.context.scene.objects:
        if o.type != "MESH":
            continue
        p = part_of(o)
        (groups[p] if p else stray).append(o)
    if stray:
        raise SystemExit(f"bodies with no part: {[o.name for o in stray]}")
    return groups


# ───────────────────────── mesh helpers ─────────────────────────
def world_bounds(objs):
    pts = [o.matrix_world @ mathutils.Vector(c) for o in objs for c in o.bound_box]
    mn = mathutils.Vector([min(p[i] for p in pts) for i in range(3)])
    mx = mathutils.Vector([max(p[i] for p in pts) for i in range(3)])
    return mn, mx


def box_object(name, mn, mx):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = mathutils.Vector([mn[i] + (v.co[i] + 0.5) * (mx[i] - mn[i]) for i in range(3)])
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def gpio_header(objs):
    """The 2 × 20 header as a spacer and 40 square pins (CAD frame: pins along X, rows
    along Z, up is -Y). About 500 triangles instead of 4000."""
    mn, mx = world_bounds(objs)
    pitch, pin = 0.00254, 0.00064
    top = mn.y                     # pin tips (up is -Y)
    board = mn.y + 0.0085          # the spacer sits on the board; the pins stand 8.5 mm
    boxes = [box_object("hdr", mathutils.Vector((mn.x, board - 0.0025, mn.z)),
                        mathutils.Vector((mx.x, board, mx.z)))]
    cx, cz = (mn.x + mx.x) / 2, (mn.z + mx.z) / 2
    for i in range(20):
        for j in (-0.5, 0.5):
            x, z = cx + (i - 9.5) * pitch, cz + j * pitch
            boxes.append(box_object("pin", mathutils.Vector((x - pin / 2, top, z - pin / 2)),
                                    mathutils.Vector((x + pin / 2, board, z + pin / 2))))
    return boxes


def bake(objs):
    """Single-user mesh data, parent transforms applied, no parent."""
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        if o.data.users > 1:            # instanced components (the two HDMI ports, …)
            o.data = o.data.copy()
        mw = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = mw
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def join(objs, name):
    bake(objs)
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = ob.data.name = name
    return ob


def tris(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


def simplify(o, budget):
    """Merge CAD seams, dissolve flat regions, triangulate, then collapse to the budget."""
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.remove_doubles(threshold=0.00002)
    bpy.ops.mesh.dissolve_limited(angle_limit=math.radians(1.0), delimit=set())
    bpy.ops.mesh.quads_convert_to_tris(quad_method="BEAUTY", ngon_method="BEAUTY")
    bpy.ops.object.mode_set(mode="OBJECT")
    n = tris(o)
    if budget and n > budget:
        mod = o.modifiers.new("decimate", "DECIMATE")
        mod.ratio = budget / n
        mod.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return o


def by_rules(objs, root, rules, name):
    """Split a part's bodies by sub-component and treat each by its rule; join the result."""
    comps = {}
    for o in objs:
        comps.setdefault(component_of(o, root), []).append(o)
    out = []
    for comp, bodies in comps.items():
        rule = rules.get(comp.split(":")[0])      # the rule is per component, not occurrence
        if rule is None:
            raise SystemExit(f"{name}: no rule for sub-component {comp!r}")
        if rule == "drop":
            continue
        if rule == "box":
            out.append(box_object(comp, *world_bounds(bodies)))
        elif rule == "pins":
            out.extend(gpio_header(bodies))
        else:
            out.append(simplify(join(bodies, comp), rule))
    return join(out, name)          # dropped bodies are cleared in build_parts


# ───────────────────────── build ─────────────────────────
def build_parts(groups):
    parts = {}
    for name, objs in groups.items():
        if name == "RASPBERRY_PI_5_1":
            parts[name] = by_rules(objs, "RASPBERRY_PI_5_1 v3", PI_RULES, name)
        elif name == "Camera_Module":
            parts[name] = by_rules(objs, "Camera Module Assem v5", CAM_RULES, name)
        else:
            parts[name] = simplify(join(objs, name), PARTS[name][1])
    for o in [o for o in bpy.data.objects if o.type == "EMPTY" or (o.type == "MESH" and o.name not in parts)]:
        bpy.data.objects.remove(o)
    return parts


def hole_centre(lid, guess, r=0.004):
    """Centre (CAD x, z) of the lid's hole near `guess`: the bounds of its rim vertices."""
    pts = [v.co for v in lid.data.vertices if math.hypot(v.co.x - guess[0], v.co.z - guess[1]) < r]
    xs, zs = [p.x for p in pts], [p.z for p in pts]
    return ((min(xs) + max(xs)) / 2, (min(zs) + max(zs)) / 2)


def add_red_led(parts):
    """The CAD has one LED. The real build has two: put an instance of it (same mesh data)
    in the lid's other hole, found by mirroring the yellow LED across the case's centre."""
    led, lid, case = parts["LED5mm_Yellow"], parts["Pi_Case_Lid"], parts["Pi_Case"]
    lmn, lmx = world_bounds([led])
    cmn, cmx = world_bounds([case])
    here = hole_centre(lid, ((lmn.x + lmx.x) / 2, (lmn.z + lmx.z) / 2))
    there = hole_centre(lid, (here[0], cmn.z + cmx.z - here[1]))
    red = bpy.data.objects.new("LED5mm_Red", led.data)          # shares the mesh: an instance
    bpy.context.scene.collection.objects.link(red)
    red.location = (there[0] - here[0], 0, there[1] - here[1])
    print(f"  LED holes (CAD mm): yellow {here[0]*1e3:.2f},{here[1]*1e3:.2f}  red {there[0]*1e3:.2f},{there[1]*1e3:.2f}")
    parts["LED5mm_Red"] = red


def orient(parts):
    """CAD frame → export frame; origin at the case's bottom centre; each part's origin at
    the centre of its bounds (so the site can move parts about their own middle)."""
    led = parts["LED5mm_Yellow"].data
    for name, o in parts.items():
        if o.data == led and name != "LED5mm_Yellow":
            o.location = CAD_TO_BLENDER @ o.location
            continue
        o.data.transform(CAD_TO_BLENDER)
    case = parts["Pi_Case"].data.vertices
    lo = [min(v.co[i] for v in case) for i in range(3)]
    hi = [max(v.co[i] for v in case) for i in range(3)]
    base = mathutils.Vector(((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]))
    parts["LED5mm_Yellow"].data.transform(mathutils.Matrix.Translation(-base))  # shared data: once
    for name, o in parts.items():
        if o.data != led:
            o.data.transform(mathutils.Matrix.Translation(-base))
    for name, o in parts.items():
        if o.data == led and name != "LED5mm_Yellow":
            continue
        vs = o.data.vertices
        c = mathutils.Vector([(min(v.co[i] for v in vs) + max(v.co[i] for v in vs)) / 2 for i in range(3)])
        o.data.transform(mathutils.Matrix.Translation(-c))
        if o.data == led:
            parts["LED5mm_Red"].location = parts["LED5mm_Red"].location + c
        o.location = c
        o.data.update()


def materials(parts):
    for name, o in parts.items():
        o.data.materials.clear()
    shared = {}
    for name, o in parts.items():
        key = "LED5mm" if name.startswith("LED5mm") else name
        if key not in shared:
            m = bpy.data.materials.new(key)
            m.diffuse_color = (*PREVIEW_COLORS.get(name, (0.5, 0.5, 0.5)), 1)
            shared[key] = m
        if not o.data.materials:
            o.data.materials.append(shared[key])


def render_preview(parts, path):
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "OBJECT"
    scene.display.shading.show_cavity = True
    scene.render.resolution_x, scene.render.resolution_y = 900, 700
    scene.world = bpy.data.worlds.new("w")
    scene.world.color = (1, 1, 1)
    for name, o in parts.items():
        o.color = (*PREVIEW_COLORS[name], 1)
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = 0.2
    target = mathutils.Vector((0, 0, 0.035))
    views = {"front": (0, 1, 0.0), "side": (1, 0, 0.0), "top": (0, 0.001, 1), "iso": (-1, 1, 0.8), "back_iso": (1, -1, 0.8)}
    for key, d in views.items():
        cam.location = target + mathutils.Vector(d).normalized() * 0.5
        cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = path.replace(".png", f"_{key}.png")
        bpy.ops.render.render(write_still=True)


def main():
    args = parse_args()
    groups = import_and_group(args.src)
    for name, objs in groups.items():
        print(f"{name}: {len(objs)} bodies, {sum(len(o.data.polygons) for o in objs)} faces")
    parts = build_parts(groups)
    add_red_led(parts)
    orient(parts)
    materials(parts)
    total = 0
    for name, o in parts.items():
        n = tris(o)
        total += n
        print(f"  {name}: {n} triangles, {len(o.data.vertices)} vertices")
    print(f"TOTAL {total} triangles drawn ({total - tris(parts['LED5mm_Red'])} stored)")
    if args.preview:
        render_preview(parts, args.preview)
        return
    bpy.ops.object.select_all(action="DESELECT")
    for o in parts.values():
        o.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=args.out, export_format="GLB", use_selection=True, export_yup=True,
        export_apply=True, export_normals=False, export_texcoords=False,
        export_materials="EXPORT", export_draco_mesh_compression_enable=False,
    )
    print("WROTE", args.out)


main()
