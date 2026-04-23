# tools/blender_export_prefab_chunks.py
# Blender 4.5+ 向け: 子コレクションごとに glTF(GLB) + マニフェスト BaseName.chunk.json を出力
# 使用: Scripting ワークスペースで本ファイルを開き実行、または blender --background file.blend --python 本ファイル
#
# 前提:
#   - 親コレクション「PrefabExport_Root」直下の各**子コレクション** = 1 チャンク（名称順 chunk_0, chunk_1 …）
#   - 各チャンクはワールド AABB 中心を算出し、一時的に原点へ平行移動してからエクスポート（戻し後、マニフェストの center にワールド座標を記録）
#   - Draco メッシュ圧縮 レベル 6
#
# 設定（必要なら下を編集）:
EXPORT_BASENAME = "MyPrefab"
OUTPUT_DIR = "//prefab_out"  # ブレンド相対（// = .blend ディレクトリ）


import bpy
import json
import os
import math
from mathutils import Vector

MIN_VERSION = (4, 5)


def _check_version():
    v = bpy.app.version
    if v < MIN_VERSION:
        raise RuntimeError(
            "Blender 4.5+ が必要です（現在: %d.%d.%d）" % (v[0], v[1], v[2])
        )


def _ensure_root_collection(name):
    if name in bpy.data.collections:
        return bpy.data.collections[name]
    col = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(col)
    return col


def _child_collections(root):
    # 直接の子（リンク順）
    ch = list(getattr(root, "children", []) or [])
    ch.sort(key=lambda c: c.name)
    return ch


def _all_objects_in_collection_and_children(col):
    out = []
    stack = [col]
    while stack:
        c = stack.pop()
        for o in c.objects:
            out.append(o)
        for ch in getattr(c, "children", []) or []:
            stack.append(ch)
    return out


def _world_aabb_min_max(objs):
    """MESH の bound_box を世界座標に変換して AABB。"""
    corners = []
    for ob in objs:
        if ob.type != "MESH" or ob.data is None:
            continue
        for corner in ob.bound_box:
            corners.append(ob.matrix_world @ Vector(corner))
    if not corners:
        return None, None
    min_c = Vector((min(p.x for p in corners), min(p.y for p in corners), min(p.z for p in corners)))
    max_c = Vector((max(p.x for p in corners), max(p.y for p in corners), max(p.z for p in corners)))
    return min_c, max_c


def _export_glb_with_draco(filepath, use_selection, export_copyright=""):
    """Blender 4.5+ の glTF エクスパラメータ（バージョンで相違する場合はエディタの Export から合わせて修正）。"""
    bpy.ops.export_scene.gltf(
        filepath=filepath,
        export_format="GLB",
        use_selection=use_selection,
        export_yup=True,
        export_apply=True,
        export_copyright=export_copyright,
        # --- Draco (gltf 2.0 エクスポータ) ---
        export_draco_mesh_compression_enable=True,
        export_draco_mesh_compression_level=6,
    )


def main():
    _check_version()
    root = _ensure_root_collection("PrefabExport_Root")
    chunks = _child_collections(root)
    if not chunks:
        raise RuntimeError(
            "コレクション「PrefabExport_Root」直下に子コレクションを1つ以上作成し、"
            "各チャンクのメッシュを配置してください。"
        )
    out_base = bpy.path.abspath(OUTPUT_DIR)
    os.makedirs(out_base, exist_ok=True)
    base = EXPORT_BASENAME.strip() or "Prefab"
    manifest = {
        "version": 1,
        "cellSize": 0,
        "baseName": base,
        "chunks": [],
    }
    for i, col in enumerate(chunks):
        objs = _all_objects_in_collection_and_children(col)
        if not objs:
            print("スキップ（空）:", col.name)
            continue
        for o in bpy.context.scene.objects:
            o.select_set(False)
        for o in objs:
            o.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        mn, mx = _world_aabb_min_max(objs)
        if mn is None or mx is None:
            print("スキップ（バウンディング不可）:", col.name)
            continue
        center_w = (mn + mx) * 0.5
        dx = mx.x - mn.x
        dy = mx.y - mn.y
        dz = mx.z - mn.z
        rad = 0.5 * math.sqrt(dx * dx + dy * dy + dz * dz)
        # ワールド原点へ平行移動（一時）→ エクスポート → 復元
        for o in objs:
            o.matrix_world.translation -= center_w
        fname = "%s.chunk_%d.glb" % (base, i)
        fpath = os.path.join(out_base, fname)
        _export_glb_with_draco(fpath, use_selection=True)
        for o in objs:
            o.matrix_world.translation += center_w
        for o in bpy.context.scene.objects:
            o.select_set(False)
        # glTF: Y 上; three と整合（エクスポートが Y 上）
        manifest["chunks"].append(
            {
                "file": "models/%s" % fname,
                "center": [float(center_w.x), float(center_w.y), float(center_w.z)],
                "radius": float(max(rad, 0.01)),
            }
        )
    if not manifest["chunks"]:
        raise RuntimeError("書き出せるチャンクがありません")
    mpath = os.path.join(out_base, "%s.chunk.json" % base)
    with open(mpath, "w", encoding="utf8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print("書き出し完了")
    print("  ディレクトリ:", out_base)
    print("  マニフェスト :", mpath)
    for ch in manifest["chunks"]:
        print("  -", ch["file"])


if __name__ == "__main__":
    main()
