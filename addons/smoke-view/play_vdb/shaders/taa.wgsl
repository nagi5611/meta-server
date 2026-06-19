struct TaaSettings {
    blend: f32,
    history_valid: u32,
    _pad: vec2f,
}

@group(0) @binding(0) var current_tex: texture_2d<unorm>;
@group(0) @binding(1) var history_tex: texture_2d<unorm>;
@group(0) @binding(2) var output_tex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var<uniform> taa_settings: TaaSettings;

fn load_rgb(tex: texture_2d<unorm>, coord: vec2i, dims: vec2u) -> vec3f {
    let clamped = clamp(coord, vec2i(0), vec2i(dims) - vec2i(1));
    return textureLoad(tex, clamped, 0).rgb;
}

@compute @workgroup_size(8, 8)
fn taaMain(@builtin(global_invocation_id) global_id: vec3u) {
    let dims = textureDimensions(output_tex);
    if global_id.x >= dims.x || global_id.y >= dims.y { return; }

    let coord = vec2i(global_id.xy);
    let current = load_rgb(current_tex, coord, dims);

    if taa_settings.history_valid == 0u {
        textureStore(output_tex, global_id.xy, vec4f(current, 1.0));
        return;
    }

    // 3x3 neighborhood clamp on current frame to reduce ghosting
    var nmin = vec3f(1e10);
    var nmax = vec3f(-1e10);
    for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
            let neighbor = load_rgb(current_tex, coord + vec2i(dx, dy), dims);
            nmin = min(nmin, neighbor);
            nmax = max(nmax, neighbor);
        }
    }

    let history = load_rgb(history_tex, coord, dims);
    let clamped_history = clamp(history, nmin, nmax);
    let result = mix(clamped_history, current, taa_settings.blend);
    textureStore(output_tex, global_id.xy, vec4f(result, 1.0));
}
