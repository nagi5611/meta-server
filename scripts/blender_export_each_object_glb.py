# scripts/blender_export_each_object_glb.py
# Blender 3.6 用: シーン内の MESH オブジェクトを 1 つずつ GLB にエクスポートする。
# Draco メッシュ圧縮を有効化し、圧縮レベルは 6 に固定。
#
# 使い方:
#   1) Blender の Scripting: 下の EXPORT_OUTPUT_DIR に完全パスを書いてから実行（None なら既定）
#   2) 環境変数 GLB_EXPORT_OUTPUT_DIR に出力フォルダの完全パスを設定してから実行
#   3) コマンドライン（-- 以降がスクリプト向け argv）:
#      blender.exe yourscene.blend --background --python scripts\blender_export_each_object_glb.py -- "D:\out\glb"
#
# 出力先の優先順位: EXPORT_OUTPUT_DIR → 環境変数 GLB_EXPORT_OUTPUT_DIR → -- 以降の第1引数 →
#   保存済み .blend と同じフォルダ内の export_glb/（未保存時はカレントの export_glb/）

import os
import re
import sys

import bpy

# Draco 圧縮レベル（要件どおり 6 固定）
DRACO_COMPRESSION_LEVEL = 6

# Scripting から実行するとき、出力フォルダの完全パス（例: r"D:\export\glb"）。None で下記の優先解決を使う。
EXPORT_OUTPUT_DIR = None


def _safe_filename(name):
    """ファイル名に使えない文字を置換する。"""
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name)
    s = s.strip().rstrip(".")
    return s or "object"


def _default_output_dir():
    """未指定時のエクスポート先（.blend 隣の export_glb、未保存時は cwd 配下）。"""
    if bpy.data.filepath:
        base = os.path.dirname(bpy.data.filepath)
    else:
        base = os.getcwd()
    return os.path.join(base, "export_glb")


def _resolve_output_dir():
    """ユーザー指定の完全パスまたは既定のエクスポート先ディレクトリを返す。"""
    raw = EXPORT_OUTPUT_DIR
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        raw = os.environ.get("GLB_EXPORT_OUTPUT_DIR")
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        if "--" in sys.argv:
            idx = sys.argv.index("--")
            tail = sys.argv[idx + 1 :]
            if tail and tail[0].strip():
                raw = tail[0]
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        out = _default_output_dir()
    else:
        out = os.path.abspath(os.path.expanduser(str(raw).strip()))
    os.makedirs(out, exist_ok=True)
    return out


def main():
    """MESH タイプのオブジェクトごとに GLB を書き出す。"""
    out_dir = _resolve_output_dir()
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not meshes:
        print("MESH オブジェクトがありません。")
        return

    view_layer = bpy.context.view_layer
    prev_active = view_layer.objects.active
    prev_selection = {o: o.select_get() for o in bpy.context.scene.objects}

    try:
        for obj in meshes:
            bpy.ops.object.select_all(action="DESELECT")
            obj.select_set(True)
            view_layer.objects.active = obj
            path = os.path.join(out_dir, _safe_filename(obj.name) + ".glb")
            bpy.ops.export_scene.gltf(
                filepath=path,
                check_existing=False,
                export_format="GLB",
                use_selection=True,
                export_draco_mesh_compression_enable=True,
                export_draco_mesh_compression_level=DRACO_COMPRESSION_LEVEL,
            )
            print(path)
    finally:
        bpy.ops.object.select_all(action="DESELECT")
        for o, sel in prev_selection.items():
            if o.name in bpy.data.objects:
                o.select_set(sel)
        if prev_active and prev_active.name in bpy.data.objects:
            view_layer.objects.active = prev_active


if __name__ == "__main__":
    main()
