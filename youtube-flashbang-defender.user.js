// ==UserScript==
// @name         YouTube - Flashbang Defender
// @namespace    https://github.com/EndzE
// @version      1.5.1
// @description  Your favourite creators don't care about your eyes opening fully white pages in their videos? Care about your eyes yourself with Flashbang Defender.
// @author       EndzE
// @license      MIT
// @icon         https://www.google.com/s2/favicons?sz=64&domain=youtube.com
// @homepageURL  https://github.com/EndzE/userscripts
// @supportURL   https://github.com/EndzE/userscripts/issues
// @match        https://www.youtube.com/*
// @match        https://youtube.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/EndzE/userscripts/main/youtube-flashbang-defender.user.js
// @updateURL    https://raw.githubusercontent.com/EndzE/userscripts/main/youtube-flashbang-defender.user.js
// ==/UserScript==

(function () {
    "use strict";

    // Teardown any previous instance in the same execution context
    if (typeof window.__YT_FBD_STOP__ === "function") {
        try { window.__YT_FBD_STOP__(); } catch { }
    }

    // --- Persistence (single backend, always validated) ---
    const STORAGE_KEY_ENABLED = "yt_flashbang_defender_enabled";
    const STORAGE_KEY_MODE = "yt_flashbang_defender_mode";
    const STORAGE_KEY_MANUAL_GAIN = "yt_flashbang_defender_manual_gain";
    const STORAGE_KEY_AUTO_SENSITIVITY = "yt_flashbang_defender_auto_sensitivity";

    const MIN_MANUAL_GAIN = 0.10;
    const MAX_MANUAL_GAIN = 0.95;
    const DEFAULT_MANUAL_GAIN = 0.60;

    const MIN_AUTO_SENSITIVITY = 0.00;
    const MAX_AUTO_SENSITIVITY = 1.00;
    const DEFAULT_AUTO_SENSITIVITY = 0.50;

    function clampManualGain(val) {
        const num = typeof val === "number" ? val : parseFloat(val);
        if (!Number.isFinite(num)) return DEFAULT_MANUAL_GAIN;
        return Math.min(MAX_MANUAL_GAIN, Math.max(MIN_MANUAL_GAIN, num));
    }

    function clampAutoSensitivity(val) {
        const num = typeof val === "number" ? val : parseFloat(val);
        if (!Number.isFinite(num)) return DEFAULT_AUTO_SENSITIVITY;
        return Math.min(MAX_AUTO_SENSITIVITY, Math.max(MIN_AUTO_SENSITIVITY, num));
    }

    function readRawSetting(key, fallback) {
        try {
            if (typeof GM_getValue === "function") {
                return GM_getValue(key, fallback);
            }
            const raw = localStorage.getItem(key);
            return raw === null ? fallback : raw;
        } catch {
            return fallback;
        }
    }

    function writeSetting(key, value) {
        try {
            if (typeof GM_setValue === "function") {
                GM_setValue(key, value);
            } else {
                localStorage.setItem(key, String(value));
            }
        } catch { }
    }

    const getSavedEnabled = () => {
        const val = readRawSetting(STORAGE_KEY_ENABLED, true);
        if (typeof val === "boolean") return val;
        return val === "false" ? false : true;
    };
    const saveEnabled = (val) => writeSetting(STORAGE_KEY_ENABLED, Boolean(val));

    const getSavedMode = () => {
        const val = readRawSetting(STORAGE_KEY_MODE, "auto");
        return val === "manual" ? "manual" : "auto";
    };
    const saveMode = (val) => writeSetting(STORAGE_KEY_MODE, val === "manual" ? "manual" : "auto");

    const getSavedManualGain = () => clampManualGain(readRawSetting(STORAGE_KEY_MANUAL_GAIN, DEFAULT_MANUAL_GAIN));
    const saveManualGain = (val) => writeSetting(STORAGE_KEY_MANUAL_GAIN, clampManualGain(val));

    const getSavedAutoSensitivity = () => clampAutoSensitivity(readRawSetting(STORAGE_KEY_AUTO_SENSITIVITY, DEFAULT_AUTO_SENSITIVITY));
    const saveAutoSensitivity = (val) => writeSetting(STORAGE_KEY_AUTO_SENSITIVITY, clampAutoSensitivity(val));

    let isEnabled = getSavedEnabled();
    let currentMode = getSavedMode(); // "auto" | "manual"
    let manualGain = getSavedManualGain(); // 0.10 - 0.95
    let autoSensitivity = getSavedAutoSensitivity(); // 0.00 - 1.00 (default 0.50)

    // --- WebGL2 Shaders (100% Core WebGL2, Zero Extensions, 1x1 RGBA32UI State) ---
    // Pass 1 VS: Pre-flips Y once per vertex
    const VERT_PASS1_SRC = `#version 300 es
precision highp float;
out highp vec2 vUv;
void main() {
    vec2 pos = vec2(
        (gl_VertexID == 1) ? 3.0 : -1.0,
        (gl_VertexID == 2) ? 3.0 : -1.0
    );
    vUv = vec2(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
    gl_Position = vec4(pos, 0.0, 1.0);
}`;

    // Pass 1 FS: 32x18 parallel downsample + previous-frame luma diff
    // Output RGBA8: (whiteness, packedActive, currLuma, lumaDiff)
    // packedActive: 0/255=none, 85/255=prevOnly, 170/255=currOnly, 255/255=both
    //   => currActive is (g >= 0.5), diffActive is (g >= 0.2)
    const PASS1_FRAG_SRC = `#version 300 es
precision mediump float;
uniform mediump sampler2D uVideo;
uniform mediump sampler2D uPrevDown;
in highp vec2 vUv;
out vec4 outColor;

void main() {
    const vec2 h = vec2(0.25 / 32.0, 0.25 / 18.0);
    vec3 rgb = 0.25 * (
        texture(uVideo, vUv + vec2(-h.x, -h.y)).rgb +
        texture(uVideo, vUv + vec2( h.x, -h.y)).rgb +
        texture(uVideo, vUv + vec2(-h.x,  h.y)).rgb +
        texture(uVideo, vUv + vec2( h.x,  h.y)).rgb
    );
    float maxC = max(rgb.r, max(rgb.g, rgb.b));
    float currActive = step(16.0 / 255.0, maxC);
    float minC = min(rgb.r, min(rgb.g, rgb.b));
    float luma = dot(rgb, vec3(0.299, 0.587, 0.114));
    float w = clamp(luma - 0.5 * (maxC - minC), 0.0, 1.0) * currActive;
    float currLuma = luma * currActive;

    vec4 prevS = texelFetch(uPrevDown, ivec2(gl_FragCoord.xy), 0);
    float prevActive = step(0.5, prevS.g);
    float packedActive = currActive * (170.0 / 255.0) + prevActive * (85.0 / 255.0);
    float lumaDiff = abs(currLuma - prevS.b);

    outColor = vec4(w, packedActive, currLuma, lumaDiff);
}`;

    // Pass 2 VS: Varying-free fullscreen triangle for 1x1 state reduction
    const VERT_PASS2_SRC = `#version 300 es
precision highp float;
void main() {
    vec2 pos = vec2(
        (gl_VertexID == 1) ? 3.0 : -1.0,
        (gl_VertexID == 2) ? 3.0 : -1.0
    );
    gl_Position = vec4(pos, 0.0, 1.0);
}`;

    // Pass 2a FS: 8x3 parallel tile reduction (24 threads x 4x6=24 texels/tile, 3x core RGBA32UI MRT)
    //   outH0: bins 0..15 packed as 4x8-bit counters per uint (max 24 <= 255)
    //   outH1: bins 16..31 packed as 4x8-bit counters per uint
    //   outStats: (sumW255, sumDiff255, activeCount | (diffActiveCount << 16), whitePixelCount)
    const PASS2A_FRAG_SRC = `#version 300 es
precision highp float;
precision highp int;

uniform mediump sampler2D uCurrDown;
uniform float uWhitePixThresh;

layout(location = 0) out uvec4 outH0;
layout(location = 1) out uvec4 outH1;
layout(location = 2) out uvec4 outStats;

void main() {
    ivec2 tile = ivec2(gl_FragCoord.xy);
    int x0 = tile.x * 4;
    int y0 = tile.y * 6;

    uvec4 h0 = uvec4(0u);
    uvec4 h1 = uvec4(0u);
    uint sumW255 = 0u;
    uint sumDiff255 = 0u;
    uint actCnt = 0u;
    uint diffCnt = 0u;
    uint whiteCnt = 0u;

    for (int dy = 0; dy < 6; dy++) {
        for (int dx = 0; dx < 4; dx++) {
            vec4 s = texelFetch(uCurrDown, ivec2(x0 + dx, y0 + dy), 0);
            uint da = uint(s.g >= 0.2);
            uint ca = uint(s.g >= 0.5);

            diffCnt += da;
            sumDiff255 += uint(s.a * 255.0 + 0.5) * da;

            actCnt += ca;
            sumW255 += uint(s.r * 255.0 + 0.5) * ca;
            whiteCnt += uint(s.r >= uWhitePixThresh) * ca;

            uint bin = min(uint(s.r * 31.0 + 0.5), 31u);
            uint addVal = ca << ((bin & 3u) << 3u);
            uint slot = bin >> 2u;
            uvec4 m = uvec4(equal(uvec4(slot & 3u), uvec4(0u, 1u, 2u, 3u))) * addVal;
            uint isHi = slot >> 2u;
            h0 += m * (1u - isHi);
            h1 += m * isHi;
        }
    }

    outH0 = h0;
    outH1 = h1;
    outStats = uvec4(sumW255, sumDiff255, actCnt | (diffCnt << 16u), whiteCnt);
}`;

    // Pass 2b FS: 1x1 RGBA32UI detector + SIMD 24-tile histogram merge + scene-cut + strobe guard
    // State uvec4:
    //   r: floatBitsToUint(gain)
    //   g: floatBitsToUint(baseline)
    //   b: packUnorm2x16(vec2(holdRemaining, strobeHeat))
    //   a: flags bitmask (bit0=hasBaseline, bit1=wasFlashing, bit2=hasPrevDown)
    const PASS2B_FRAG_SRC = `#version 300 es
precision highp float;
precision highp int;

uniform highp usampler2D uTileH0;
uniform highp usampler2D uTileH1;
uniform highp usampler2D uTileStats;
uniform highp usampler2D uPrevState;
uniform float uDtMs;
uniform int uResetState;
uniform float uSensitivity;

out uvec4 outState;

const float MIN_ACTIVE_PIXELS     = 144.0;
const float MAX_WHITE_LUMA        = 140.0 / 255.0;
const float AUTO_AIM              = 0.55;
const float BASELINE_TAU_MS       = 1000.0;
const float MIN_GAIN              = 0.05;

const float SCENE_CUT_DIFF        = 0.22;
const float NORMAL_RELEASE_MS     = 350.0;
const float STROBE_ONSET_BUMP     = 0.36;
const float STROBE_DECAY_MS       = 1800.0;
const float STROBE_THRESHOLD      = 0.55;
const float STROBE_HOLD_MS        = 750.0;

void consumePair(uint packed, int baseBin, int topCount, inout int taken, inout int peakSum) {
    int hi = int(packed >> 16u);
    int takeHi = min(hi, topCount - taken);
    peakSum += takeHi * (baseBin + 1);
    taken += takeHi;
    int lo = int(packed & 0xFFFFu);
    int takeLo = min(lo, topCount - taken);
    peakSum += takeLo * baseBin;
    taken += takeLo;
}

void main() {
    bool hasBaseline = false;
    bool wasFlashing = false;
    bool hasPrevDown = false;
    float baseline = 0.0;
    float currentGain = 1.0;
    float holdRemaining = 0.0;
    float strobeHeat = 0.0;

    if (uResetState == 0) {
        uvec4 prev = texelFetch(uPrevState, ivec2(0, 0), 0);
        currentGain = uintBitsToFloat(prev.r);
        baseline = uintBitsToFloat(prev.g);
        vec2 hs = unpackUnorm2x16(prev.b);
        holdRemaining = hs.x;
        strobeHeat = hs.y;
        hasBaseline = (prev.a & 1u) != 0u;
        wasFlashing = (prev.a & 2u) != 0u;
        hasPrevDown = (prev.a & 4u) != 0u;
    }

    // Merge 24 tiles (8x3), widening 8-bit bins to 16-bit SIMD lanes (max 576 << 65535)
    uvec4 a0 = uvec4(0u);
    uvec4 a1 = uvec4(0u);
    uvec4 b0 = uvec4(0u);
    uvec4 b1 = uvec4(0u);
    uvec4 st = uvec4(0u);

    for (int ty = 0; ty < 3; ty++) {
        for (int tx = 0; tx < 8; tx++) {
            uvec4 r0 = texelFetch(uTileH0, ivec2(tx, ty), 0);
            uvec4 r1 = texelFetch(uTileH1, ivec2(tx, ty), 0);
            a0 += r0 & 0x00FF00FFu;
            a1 += (r0 >> 8u) & 0x00FF00FFu;
            b0 += r1 & 0x00FF00FFu;
            b1 += (r1 >> 8u) & 0x00FF00FFu;
            st += texelFetch(uTileStats, ivec2(tx, ty), 0);
        }
    }

    float totalWhite = float(st.x) / 255.0;
    float frameDiff = float(st.y) / 255.0;
    float activePixels = float(st.z & 0xFFFFu);
    float diffActivePixels = float(st.z >> 16u);
    float whitePixelCount = float(st.w);

    float denom = max(activePixels, MIN_ACTIVE_PIXELS);
    int topCount = max(1, int(floor(denom * 0.10 + 0.5)));

    int taken = 0;
    int peakSum = 0;
    consumePair((b1.w & 0xFFFF0000u) | (b0.w >> 16u), 30, topCount, taken, peakSum);
    consumePair(((b1.w & 0xFFFFu) << 16u) | (b0.w & 0xFFFFu), 28, topCount, taken, peakSum);
    consumePair((b1.z & 0xFFFF0000u) | (b0.z >> 16u), 26, topCount, taken, peakSum);
    consumePair(((b1.z & 0xFFFFu) << 16u) | (b0.z & 0xFFFFu), 24, topCount, taken, peakSum);
    if (taken < topCount) {
        consumePair((b1.y & 0xFFFF0000u) | (b0.y >> 16u), 22, topCount, taken, peakSum);
        consumePair(((b1.y & 0xFFFFu) << 16u) | (b0.y & 0xFFFFu), 20, topCount, taken, peakSum);
        consumePair((b1.x & 0xFFFF0000u) | (b0.x >> 16u), 18, topCount, taken, peakSum);
        consumePair(((b1.x & 0xFFFFu) << 16u) | (b0.x & 0xFFFFu), 16, topCount, taken, peakSum);
    }
    if (taken < topCount) {
        consumePair((a1.w & 0xFFFF0000u) | (a0.w >> 16u), 14, topCount, taken, peakSum);
        consumePair(((a1.w & 0xFFFFu) << 16u) | (a0.w & 0xFFFFu), 12, topCount, taken, peakSum);
        consumePair((a1.z & 0xFFFF0000u) | (a0.z >> 16u), 10, topCount, taken, peakSum);
        consumePair(((a1.z & 0xFFFFu) << 16u) | (a0.z & 0xFFFFu), 8, topCount, taken, peakSum);
    }
    if (taken < topCount) {
        consumePair((a1.y & 0xFFFF0000u) | (a0.y >> 16u), 6, topCount, taken, peakSum);
        consumePair(((a1.y & 0xFFFFu) << 16u) | (a0.y & 0xFFFFu), 4, topCount, taken, peakSum);
        consumePair((a1.x & 0xFFFF0000u) | (a0.x >> 16u), 2, topCount, taken, peakSum);
        consumePair(((a1.x & 0xFFFFu) << 16u) | (a0.x & 0xFFFFu), 0, topCount, taken, peakSum);
    }

    float whiteMean = totalWhite / denom;
    float whitePeak = (taken > 0) ? (float(peakSum) / (float(taken) * 31.0)) : 0.0;
    float whiteRatio = whitePixelCount / denom;

    float diffDenom = max(diffActivePixels, MIN_ACTIVE_PIXELS);
    float meanFrameDiff = hasPrevDown ? (frameDiff / diffDenom) : 0.0;
    bool isSceneCut = hasPrevDown && (meanFrameDiff >= SCENE_CUT_DIFF);

    // Sensitivity-scaled thresholds (0.0 = strictest, 0.5 = balanced default, 1.0 = most sensitive)
    float sens = clamp(uSensitivity, 0.0, 1.0);
    float sustainedPeak  = mix(238.0 / 255.0, 214.0 / 255.0, sens);
    float sustainedMean  = mix(165.0 / 255.0, 115.0 / 255.0, sens);
    float sustainedRatio = mix(0.52, 0.24, sens);
    float flashPeak      = mix(225.0 / 255.0, 195.0 / 255.0, sens);
    float flashDelta     = mix(65.0 / 255.0, 25.0 / 255.0, sens);
    float flashRatio     = mix(0.38, 0.16, sens);

    bool isSustainedWhite =
        (whitePeak >= sustainedPeak) &&
        (whiteMean >= sustainedMean) &&
        (whiteRatio >= sustainedRatio);

    bool isSuddenFlash =
        hasBaseline &&
        (whitePeak >= flashPeak) &&
        ((whitePeak - baseline) >= flashDelta) &&
        (whiteRatio >= flashRatio);

    bool isFlashing = isSustainedWhite || isSuddenFlash;

    float nextStrobeHeat = max(0.0, strobeHeat - (uDtMs / STROBE_DECAY_MS));
    if (isFlashing && !wasFlashing) {
        nextStrobeHeat = min(1.0, nextStrobeHeat + STROBE_ONSET_BUMP);
    }

    float nextBaseline = baseline;
    bool nextHasBaseline = hasBaseline;
    float nextHold = holdRemaining;

    if (isFlashing) {
        if (nextStrobeHeat >= STROBE_THRESHOLD) {
            nextHold = 1.0;
        }
    } else {
        if (isSceneCut && (!hasBaseline || whitePeak < baseline)) {
            nextBaseline = whitePeak;
        } else {
            float alpha = 1.0 - exp(-uDtMs / BASELINE_TAU_MS);
            nextBaseline = hasBaseline ? (baseline + alpha * (whitePeak - baseline)) : whitePeak;
        }
        nextHasBaseline = true;
        nextHold = max(0.0, holdRemaining - (uDtMs / STROBE_HOLD_MS));
    }

    float targetGain = 1.0;
    if (isFlashing) {
        float safePeak = max(0.004, whitePeak);
        if (isSustainedWhite) {
            targetGain = clamp(MAX_WHITE_LUMA / safePeak, MIN_GAIN, 1.0);
        }
        if (isSuddenFlash) {
            float base = hasBaseline ? baseline : (80.0 / 255.0);
            float targetLuma = whitePeak - (whitePeak - base) * AUTO_AIM;
            float flashGain = clamp(targetLuma / safePeak, MIN_GAIN, 1.0);
            targetGain = isSustainedWhite ? min(targetGain, flashGain) : flashGain;
        }
    }

    float nextGain = currentGain;
    if (targetGain < currentGain) {
        nextGain = targetGain;
    } else if (!isFlashing && nextHold <= 0.0) {
        float washFactor = max(
            smoothstep(sustainedRatio * 0.55, sustainedRatio * 0.95, whiteRatio),
            smoothstep(sustainedMean * 1.05, sustainedMean * 1.35, whiteMean)
        );
        float ceilingGain = clamp(MAX_WHITE_LUMA / max(0.004, whitePeak), MIN_GAIN, 1.0);
        float recoveryTarget = mix(1.0, ceilingGain, washFactor);

        if (recoveryTarget > currentGain) {
            if (isSceneCut && washFactor < 0.25) {
                nextGain = recoveryTarget;
            } else {
                float releaseStep = uDtMs / NORMAL_RELEASE_MS;
                nextGain = min(recoveryTarget, currentGain + releaseStep);
            }
        }
    }

    uint flags = (nextHasBaseline ? 1u : 0u) | (isFlashing ? 2u : 0u) | 4u;
    outState = uvec4(
        floatBitsToUint(nextGain),
        floatBitsToUint(nextBaseline),
        packUnorm2x16(vec2(nextHold, nextStrobeHeat)),
        flags
    );
}`;

    // Pass 3 VS: Fetches gain once per vertex (3x/frame instead of millions) + transforms UV
    const VERT_PASS3_SRC = `#version 300 es
precision highp float;
uniform highp usampler2D uState;
uniform vec2 uUvScale;
out highp vec2 vUv;
flat out mediump float vGain;

void main() {
    vec2 pos = vec2(
        (gl_VertexID == 1) ? 3.0 : -1.0,
        (gl_VertexID == 2) ? 3.0 : -1.0
    );
    vec2 rawUv = vec2(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
    vUv = (rawUv - 0.5) * uUvScale + 0.5;
    vGain = uintBitsToFloat(texelFetch(uState, ivec2(0, 0), 0).r);
    gl_Position = vec4(pos, 0.0, 1.0);
}`;

    // Pass 3 FS: Minimal branchless FP16 display pass (1 texture fetch + 1 multiply)
    const PASS3_FRAG_SRC = `#version 300 es
precision mediump float;
uniform mediump sampler2D uVideo;
in highp vec2 vUv;
flat in mediump float vGain;
out vec4 outColor;

void main() {
    outColor = vec4(texture(uVideo, vUv).rgb * vGain, 1.0);
}`;

    // --- WebGL2 Renderer State ---
    let glCanvas = null;
    let gl = null;
    let glVao = null;
    let progPass1 = null;
    let progPass2a = null;
    let progPass2b = null;
    let progPass3 = null;
    let extParallelCompile = null;
    let programsReady = false;
    let pendingShaders = [];
    let compilePollRafId = null;
    let locWhitePixThresh = null;
    let locDtMs = null;
    let locResetState = null;
    let locSensitivity = null;
    let locUvScale = null;

    let videoTex = null;
    let downTex = [null, null];
    let downFbo = [null, null];
    let downReadIdx = 0;
    let downWriteIdx = 1;

    let tileTex = [null, null, null];
    let tileFbo = null;

    let stateTex = [null, null];
    let stateFbo = [null, null];
    let stateReadIdx = 0;
    let stateWriteIdx = 1;

    // Cached GL uniform / viewport state
    let lastSentReset = -1;
    let lastUploadedSensitivity = NaN;
    let uvScaleX = 1.0;
    let uvScaleY = 1.0;
    let lastUploadedUvScaleX = NaN;
    let lastUploadedUvScaleY = NaN;
    let uvContain = false;
    let vpX = 0;
    let vpY = 0;
    let vpW = 1;
    let vpH = 1;

    // Cached layout state (avoids 60Hz DOM/layout reads)
    let layoutDirty = true;
    let layoutRafId = null;
    let cachedCssW = 0;
    let cachedCssH = 0;
    let cachedLeft = NaN;
    let cachedTop = NaN;
    let cachedTransform = "";
    let cachedObjectFit = "";
    let cachedVideoW = 0;
    let cachedVideoH = 0;
    let cachedTargetW = 0;
    let cachedTargetH = 0;
    let lastInlineW = "";
    let lastInlineH = "";
    let lastInlineL = "";
    let lastInlineT = "";
    let lastInlineTransform = "";
    let isOverlayVisible = false;

    let isContextLost = false;
    let webglFailed = false;
    let hasRenderedFrame = false;
    let needsStateReset = true;
    let lastFrameTime = 0;
    let lastPresentedFrames = -1;
    let lastVideoTime = -1;

    // --- Runtime / Lifecycle State ---
    let activeVideo = null;
    let videoSupportsVfc = false;
    let frameHandle = null;
    let isUsingVfc = false;
    let isIntersecting = true;
    let lastNavUrl = location.href;

    let navTimer = null;
    let mountRetryTimer = null;

    let videoIntersectionObserver = null;
    let videoResizeObserver = null;
    let videoStyleObserver = null;
    let actionBarObserver = null;
    let observedActionBar = null;
    let actionBarSyncQueued = false;

    // Cached UI element references
    let styleEl = null;
    let wrapperEl = null;
    let btnEl = null;
    let dotEl = null;
    let tooltipEl = null;
    let popupEl = null;
    let powerPillEl = null;
    let optAutoEl = null;
    let optManualEl = null;
    let sliderContEl = null;
    let sliderLabelEl = null;
    let sliderInputEl = null;
    let sliderValEl = null;
    let isPopupOpen = false;
    let lastBtnStateKey = "";

    // Disabled: desynchronized causes D3D11/DWM swapchain stall spikes on desktop displays
    const USE_DESYNCHRONIZED = false;

    // --- WebGL2 Setup & Teardown ---
    function cancelCompilePoll() {
        if (compilePollRafId !== null) {
            cancelAnimationFrame(compilePollRafId);
            compilePollRafId = null;
        }
    }

    function deletePendingShaders() {
        if (gl && !gl.isContextLost()) {
            for (let i = 0; i < pendingShaders.length; i++) {
                try { gl.deleteShader(pendingShaders[i]); } catch { }
            }
        }
        pendingShaders = [];
    }

    function startProgramLink(context, vertSrc, fragSrc) {
        const vs = context.createShader(context.VERTEX_SHADER);
        context.shaderSource(vs, vertSrc);
        context.compileShader(vs);

        const fs = context.createShader(context.FRAGMENT_SHADER);
        context.shaderSource(fs, fragSrc);
        context.compileShader(fs);

        const prog = context.createProgram();
        context.attachShader(prog, vs);
        context.attachShader(prog, fs);
        context.linkProgram(prog);
        pendingShaders.push(vs, fs);
        return prog;
    }

    function getWhitePixThreshold(sens) {
        // 0.0 (strict) -> 230/255, 0.5 (balanced default) -> 205/255, 1.0 (sensitive) -> 180/255
        return (230.0 - 50.0 * sens) / 255.0;
    }

    function uploadSensitivityUniforms() {
        if (!gl || !programsReady || isContextLost || webglFailed) return;
        if (autoSensitivity === lastUploadedSensitivity) return;
        if (progPass2a && locWhitePixThresh) {
            gl.useProgram(progPass2a);
            gl.uniform1f(locWhitePixThresh, getWhitePixThreshold(autoSensitivity));
        }
        if (progPass2b && locSensitivity) {
            gl.useProgram(progPass2b);
            gl.uniform1f(locSensitivity, autoSensitivity);
        }
        gl.useProgram(null);
        lastUploadedSensitivity = autoSensitivity;
    }

    function finalizePrograms() {
        if (!gl || !progPass1 || !progPass2a || !progPass2b || !progPass3) return false;
        try {
            const progs = [progPass1, progPass2a, progPass2b, progPass3];
            for (let i = 0; i < progs.length; i++) {
                if (!gl.getProgramParameter(progs[i], gl.LINK_STATUS)) {
                    throw new Error("Program link error: " + gl.getProgramInfoLog(progs[i]));
                }
            }
            deletePendingShaders();

            // Dedicated persistent texture units:
            //   Unit 0: videoTex (never rebound)
            //   Unit 1: downTex ping-pong
            //   Unit 2: stateTex ping-pong
            //   Units 3..5: tileTex[0..2] (8x3 MRT, never rebound)
            gl.useProgram(progPass1);
            gl.uniform1i(gl.getUniformLocation(progPass1, "uVideo"), 0);
            gl.uniform1i(gl.getUniformLocation(progPass1, "uPrevDown"), 1);

            gl.useProgram(progPass2a);
            gl.uniform1i(gl.getUniformLocation(progPass2a, "uCurrDown"), 1);
            locWhitePixThresh = gl.getUniformLocation(progPass2a, "uWhitePixThresh");
            gl.uniform1f(locWhitePixThresh, getWhitePixThreshold(autoSensitivity));

            gl.useProgram(progPass2b);
            gl.uniform1i(gl.getUniformLocation(progPass2b, "uPrevState"), 2);
            gl.uniform1i(gl.getUniformLocation(progPass2b, "uTileH0"), 3);
            gl.uniform1i(gl.getUniformLocation(progPass2b, "uTileH1"), 4);
            gl.uniform1i(gl.getUniformLocation(progPass2b, "uTileStats"), 5);
            locDtMs = gl.getUniformLocation(progPass2b, "uDtMs");
            locResetState = gl.getUniformLocation(progPass2b, "uResetState");
            locSensitivity = gl.getUniformLocation(progPass2b, "uSensitivity");
            gl.uniform1f(locSensitivity, autoSensitivity);
            lastUploadedSensitivity = autoSensitivity;

            gl.useProgram(progPass3);
            gl.uniform1i(gl.getUniformLocation(progPass3, "uVideo"), 0);
            gl.uniform1i(gl.getUniformLocation(progPass3, "uState"), 2);
            locUvScale = gl.getUniformLocation(progPass3, "uUvScale");
            gl.uniform2f(locUvScale, uvScaleX, uvScaleY);
            lastUploadedUvScaleX = uvScaleX;
            lastUploadedUvScaleY = uvScaleY;
            gl.useProgram(null);

            programsReady = true;
            return true;
        } catch {
            deletePendingShaders();
            handleFatalWebGLError();
            return false;
        }
    }

    function checkProgramsReady() {
        if (programsReady) return true;
        if (!gl || isContextLost || webglFailed || !progPass1 || !progPass2a || !progPass2b || !progPass3) {
            return false;
        }
        if (extParallelCompile) {
            const flag = extParallelCompile.COMPLETION_STATUS_KHR;
            if (
                !gl.getProgramParameter(progPass1, flag) ||
                !gl.getProgramParameter(progPass2a, flag) ||
                !gl.getProgramParameter(progPass2b, flag) ||
                !gl.getProgramParameter(progPass3, flag)
            ) {
                return false;
            }
        }
        return finalizePrograms();
    }

    function scheduleCompilePoll() {
        if (compilePollRafId !== null || programsReady || webglFailed || isContextLost) return;
        compilePollRafId = requestAnimationFrame(() => {
            compilePollRafId = null;
            if (!isEnabled || currentMode !== "auto" || !activeVideo || webglFailed || isContextLost) return;
            if (checkProgramsReady()) {
                if (activeVideo.paused && activeVideo.readyState >= 2) {
                    renderFrame(activeVideo, true, performance.now());
                } else {
                    scheduleNextFrame(activeVideo);
                }
            } else {
                scheduleCompilePoll();
            }
        });
    }

    function createVideoTexture(context) {
        const tex = context.createTexture();
        context.bindTexture(context.TEXTURE_2D, tex);
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR);
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_BASE_LEVEL, 0);
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAX_LEVEL, 0);
        return tex;
    }

    function createImmutableTexture(context, internalFormat, w, h, filter) {
        const tex = context.createTexture();
        context.bindTexture(context.TEXTURE_2D, tex);
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, filter);
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, filter);
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
        context.texStorage2D(context.TEXTURE_2D, 1, internalFormat, w, h);
        return tex;
    }

    function createFbo(context, tex) {
        const fbo = context.createFramebuffer();
        context.bindFramebuffer(context.FRAMEBUFFER, fbo);
        context.framebufferTexture2D(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.TEXTURE_2D, tex, 0);
        const status = context.checkFramebufferStatus(context.FRAMEBUFFER);
        context.bindFramebuffer(context.FRAMEBUFFER, null);
        if (status !== context.FRAMEBUFFER_COMPLETE) {
            context.deleteFramebuffer(fbo);
            throw new Error("Incomplete FBO: " + status);
        }
        return fbo;
    }

    function createTileMrtFbo(context, textures) {
        const fbo = context.createFramebuffer();
        context.bindFramebuffer(context.FRAMEBUFFER, fbo);
        context.framebufferTexture2D(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.TEXTURE_2D, textures[0], 0);
        context.framebufferTexture2D(context.FRAMEBUFFER, context.COLOR_ATTACHMENT1, context.TEXTURE_2D, textures[1], 0);
        context.framebufferTexture2D(context.FRAMEBUFFER, context.COLOR_ATTACHMENT2, context.TEXTURE_2D, textures[2], 0);
        context.drawBuffers([context.COLOR_ATTACHMENT0, context.COLOR_ATTACHMENT1, context.COLOR_ATTACHMENT2]);
        const status = context.checkFramebufferStatus(context.FRAMEBUFFER);
        context.bindFramebuffer(context.FRAMEBUFFER, null);
        if (status !== context.FRAMEBUFFER_COMPLETE) {
            context.deleteFramebuffer(fbo);
            throw new Error("Incomplete MRT FBO: " + status);
        }
        return fbo;
    }

    function initWebGLResources() {
        if (!gl) return false;
        try {
            cancelCompilePoll();
            programsReady = false;
            extParallelCompile = gl.getExtension("KHR_parallel_shader_compile");

            glVao = gl.createVertexArray();
            gl.bindVertexArray(glVao); // Permanently bound for this private context

            // Kick off all shader compiles & links upfront (non-blocking when KHR_parallel_shader_compile is present)
            progPass1 = startProgramLink(gl, VERT_PASS1_SRC, PASS1_FRAG_SRC);
            progPass2a = startProgramLink(gl, VERT_PASS2_SRC, PASS2A_FRAG_SRC);
            progPass2b = startProgramLink(gl, VERT_PASS2_SRC, PASS2B_FRAG_SRC);
            progPass3 = startProgramLink(gl, VERT_PASS3_SRC, PASS3_FRAG_SRC);

            videoTex = createVideoTexture(gl);

            downTex[0] = createImmutableTexture(gl, gl.RGBA8, 32, 18, gl.NEAREST);
            downTex[1] = createImmutableTexture(gl, gl.RGBA8, 32, 18, gl.NEAREST);
            downFbo[0] = createFbo(gl, downTex[0]);
            downFbo[1] = createFbo(gl, downTex[1]);

            tileTex[0] = createImmutableTexture(gl, gl.RGBA32UI, 8, 3, gl.NEAREST);
            tileTex[1] = createImmutableTexture(gl, gl.RGBA32UI, 8, 3, gl.NEAREST);
            tileTex[2] = createImmutableTexture(gl, gl.RGBA32UI, 8, 3, gl.NEAREST);
            tileFbo = createTileMrtFbo(gl, tileTex);

            // Initial 1x1 RGBA32UI state: gain=1.0f (0x3F800000), baseline=0, hold/heat=0, flags=0
            const initState = new Uint32Array([0x3F800000, 0, 0, 0]);
            stateTex[0] = createImmutableTexture(gl, gl.RGBA32UI, 1, 1, gl.NEAREST);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, initState);
            stateTex[1] = createImmutableTexture(gl, gl.RGBA32UI, 1, 1, gl.NEAREST);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, initState);
            stateFbo[0] = createFbo(gl, stateTex[0]);
            stateFbo[1] = createFbo(gl, stateTex[1]);

            downReadIdx = 0;
            downWriteIdx = 1;
            stateReadIdx = 0;
            stateWriteIdx = 1;
            needsStateReset = true;
            lastSentReset = -1;

            // Establish all persistent unit bindings AFTER all textures are created
            gl.activeTexture(gl.TEXTURE5);
            gl.bindTexture(gl.TEXTURE_2D, tileTex[2]);
            gl.activeTexture(gl.TEXTURE4);
            gl.bindTexture(gl.TEXTURE_2D, tileTex[1]);
            gl.activeTexture(gl.TEXTURE3);
            gl.bindTexture(gl.TEXTURE_2D, tileTex[0]);
            gl.activeTexture(gl.TEXTURE2);
            gl.bindTexture(gl.TEXTURE_2D, stateTex[0]);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, downTex[0]);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, videoTex);

            gl.clearColor(0.0, 0.0, 0.0, 1.0);
            gl.disable(gl.DEPTH_TEST);
            gl.disable(gl.BLEND);

            if (!extParallelCompile) {
                return finalizePrograms();
            }
            checkProgramsReady();
            return !webglFailed;
        } catch {
            webglFailed = true;
            destroyWebGLResources();
            return false;
        }
    }

    function destroyWebGLResources() {
        cancelCompilePoll();
        deletePendingShaders();
        if (gl && !gl.isContextLost()) {
            try {
                if (videoTex) gl.deleteTexture(videoTex);
                if (downTex[0]) gl.deleteTexture(downTex[0]);
                if (downTex[1]) gl.deleteTexture(downTex[1]);
                if (downFbo[0]) gl.deleteFramebuffer(downFbo[0]);
                if (downFbo[1]) gl.deleteFramebuffer(downFbo[1]);
                if (tileTex[0]) gl.deleteTexture(tileTex[0]);
                if (tileTex[1]) gl.deleteTexture(tileTex[1]);
                if (tileTex[2]) gl.deleteTexture(tileTex[2]);
                if (tileFbo) gl.deleteFramebuffer(tileFbo);
                if (stateTex[0]) gl.deleteTexture(stateTex[0]);
                if (stateTex[1]) gl.deleteTexture(stateTex[1]);
                if (stateFbo[0]) gl.deleteFramebuffer(stateFbo[0]);
                if (stateFbo[1]) gl.deleteFramebuffer(stateFbo[1]);
                if (progPass1) gl.deleteProgram(progPass1);
                if (progPass2a) gl.deleteProgram(progPass2a);
                if (progPass2b) gl.deleteProgram(progPass2b);
                if (progPass3) gl.deleteProgram(progPass3);
                if (glVao) gl.deleteVertexArray(glVao);
            } catch { }
        }
        glVao = null;
        progPass1 = progPass2a = progPass2b = progPass3 = null;
        extParallelCompile = null;
        programsReady = false;
        videoTex = null;
        downTex = [null, null];
        downFbo = [null, null];
        tileTex = [null, null, null];
        tileFbo = null;
        stateTex = [null, null];
        stateFbo = [null, null];
        locWhitePixThresh = locDtMs = locResetState = locSensitivity = locUvScale = null;
        lastSentReset = -1;
        lastUploadedSensitivity = NaN;
        lastUploadedUvScaleX = NaN;
        lastUploadedUvScaleY = NaN;
    }

    function releaseIdleVram() {
        if (!glCanvas || !gl || isContextLost) return;
        try {
            gl.activeTexture(gl.TEXTURE0);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        } catch { }
        if (glCanvas.width !== 1 || glCanvas.height !== 1) {
            glCanvas.width = 1;
            glCanvas.height = 1;
        }
        cachedTargetW = 1;
        cachedTargetH = 1;
        layoutDirty = true;
    }

    function onContextLost(e) {
        e.preventDefault();
        isContextLost = true;
        programsReady = false;
        cancelCompilePoll();
        cancelFrameLoop();
        deactivateOverlayVisibility(false);
    }

    function onContextRestored() {
        isContextLost = false;
        webglFailed = false;
        layoutDirty = true;
        cachedTargetW = 0;
        cachedTargetH = 0;
        if (initWebGLResources() && isEnabled && currentMode === "auto" && activeVideo) {
            syncCanvasLayout();
            if (activeVideo.paused && activeVideo.readyState >= 2) {
                renderFrame(activeVideo, true, performance.now());
            } else {
                scheduleNextFrame(activeVideo);
            }
        }
    }

    function ensureStyles() {
        if (styleEl && styleEl.isConnected) return;
        document.getElementById("yt-fbd-styles")?.remove();
        styleEl = document.createElement("style");
        styleEl.id = "yt-fbd-styles";
        styleEl.textContent = `
#yt-fbd-webgl-canvas {
    position: absolute;
    top: 0;
    left: 0;
    width: 0;
    height: 0;
    pointer-events: none;
    display: none;
    margin: 0;
    padding: 0;
    border: 0;
    contain: strict;
}
#yt-flashbang-defender-wrapper {
    position: relative;
    display: inline-flex;
    align-items: center;
    margin: 0 8px;
    flex-shrink: 0;
    vertical-align: middle;
    height: 40px;
}
#yt-flashbang-defender-btn {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    border-radius: 20px;
    border: none;
    background-color: var(--yt-spec-badge-chip-background, var(--yt-sys-color-baseline--additive-background, rgba(0, 0, 0, 0.05)));
    color: var(--yt-spec-text-primary, var(--yt-sys-color-baseline--text-primary, #0f0f0f));
    cursor: pointer;
    padding: 0;
    margin: 0;
    box-sizing: border-box;
    transition: background-color 0.2s;
}
#yt-flashbang-defender-wrapper:hover #yt-flashbang-defender-btn {
    background-color: var(--yt-spec-button-chip-background-hover, var(--yt-sys-color-baseline--button-chip-background-hover, rgba(0, 0, 0, 0.1)));
}
html[dark] #yt-flashbang-defender-btn {
    background-color: var(--yt-spec-badge-chip-background, var(--yt-sys-color-baseline--additive-background, rgba(255, 255, 255, 0.1)));
    color: var(--yt-spec-text-primary, var(--yt-sys-color-baseline--text-primary, #f1f1f1));
}
html[dark] #yt-flashbang-defender-wrapper:hover #yt-flashbang-defender-btn {
    background-color: var(--yt-spec-button-chip-background-hover, var(--yt-sys-color-baseline--button-chip-background-hover, rgba(255, 255, 255, 0.2)));
}
#yt-fbd-green-dot {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background-color: #00c853;
    box-shadow: 0 0 3px rgba(0, 200, 83, 0.7);
    pointer-events: none;
}
html[dark] #yt-fbd-green-dot {
    background-color: #00e676;
    box-shadow: 0 0 3px rgba(0, 230, 118, 0.7);
}
#yt-flashbang-defender-btn[aria-pressed="false"] #yt-fbd-green-dot {
    display: none;
}
#yt-flashbang-defender-tooltip {
    position: absolute;
    bottom: calc(100% + 10px);
    left: 50%;
    transform: translateX(-50%);
    background-color: rgba(97, 97, 97, 0.95);
    color: #ffffff;
    font-family: "Roboto", "Arial", sans-serif;
    font-size: 12px;
    line-height: 16px;
    font-weight: 400;
    padding: 6px 10px;
    border-radius: 4px;
    white-space: nowrap;
    pointer-events: none;
    opacity: 0;
    visibility: hidden;
    transition: opacity 0.15s ease-in-out, visibility 0.15s;
    z-index: 99999;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
}
#yt-flashbang-defender-wrapper:hover:not([data-popup-open="true"]) #yt-flashbang-defender-tooltip {
    opacity: 1;
    visibility: visible;
}
#yt-flashbang-defender-wrapper[data-layout="shorts"] {
    margin: 0 0 16px 0;
    width: 48px;
    height: 48px;
    justify-content: center;
}
#yt-flashbang-defender-wrapper[data-layout="shorts"] #yt-flashbang-defender-btn {
    width: 48px;
    height: 48px;
    border-radius: 24px;
}
#yt-flashbang-defender-wrapper[data-layout="shorts"] #yt-fbd-green-dot {
    top: 8px;
    right: 8px;
    width: 6px;
    height: 6px;
}
#yt-flashbang-defender-wrapper[data-layout="shorts"] #yt-flashbang-defender-tooltip {
    top: calc(100% + 10px);
    bottom: auto;
}
#yt-flashbang-defender-popup {
    position: fixed;
    top: 0;
    left: 0;
    width: 232px;
    background-color: rgba(28, 28, 28, 0.98);
    color: #ffffff;
    font-family: "Roboto", "Arial", sans-serif;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 12px;
    padding: 8px 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.7);
    z-index: 2147483647;
    display: none;
    flex-direction: column;
    gap: 2px;
    user-select: none;
    box-sizing: border-box;
}
.yt-fbd-popup-header {
    padding: 4px 10px 6px 10px;
    font-size: 11px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: rgba(255, 255, 255, 0.55);
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    margin-bottom: 4px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
}
#yt-fbd-power-pill {
    border: none;
    border-radius: 999px;
    padding: 2px 8px;
    font-family: inherit;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.4px;
    cursor: pointer;
    background-color: rgba(255, 255, 255, 0.1);
    color: rgba(255, 255, 255, 0.65);
    transition: background-color 0.15s ease, color 0.15s ease;
}
#yt-fbd-power-pill[aria-pressed="true"] {
    background-color: rgba(0, 230, 118, 0.18);
    color: #00e676;
}
.yt-fbd-mode-group {
    display: flex;
    flex-direction: column;
    gap: 2px;
}
.yt-fbd-popup-opt {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 8px 10px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: inherit;
    font-family: inherit;
    text-align: left;
    cursor: pointer;
    transition: background-color 0.15s ease;
    box-sizing: border-box;
}
.yt-fbd-popup-opt[data-active="true"] {
    background-color: rgba(255, 255, 255, 0.08);
}
.yt-fbd-popup-opt:hover {
    background-color: rgba(255, 255, 255, 0.12);
}
.yt-fbd-opt-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
}
.yt-fbd-opt-title {
    font-size: 13px;
    font-weight: 500;
    color: #ffffff;
}
.yt-fbd-opt-desc {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.6);
}
.yt-fbd-opt-check {
    font-size: 14px;
    font-weight: 700;
    color: #00e676;
    margin-left: 8px;
    opacity: 0;
    transition: opacity 0.15s ease;
}
.yt-fbd-popup-opt[data-active="true"] .yt-fbd-opt-check {
    opacity: 1;
}
#yt-fbd-slider-container {
    margin-top: 6px;
    padding: 6px 10px 4px 10px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    display: flex;
    flex-direction: column;
    gap: 4px;
    transition: opacity 0.2s ease;
}
#yt-fbd-slider-container[data-disabled="true"] {
    opacity: 0.4;
    pointer-events: none;
}
.yt-fbd-slider-header {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
    color: rgba(255, 255, 255, 0.7);
}
#yt-fbd-slider-val {
    font-weight: 600;
    color: #00e676;
}
#yt-fbd-slider-input {
    width: 100%;
    margin: 4px 0 2px 0;
    accent-color: #00e676;
    cursor: pointer;
}`;
        (document.head || document.documentElement).appendChild(styleEl);
    }

    function ensureWebGLCanvas() {
        if (glCanvas && gl) return true;
        if (webglFailed) return false;

        ensureStyles();
        glCanvas = document.createElement("canvas");
        glCanvas.id = "yt-fbd-webgl-canvas";
        glCanvas.setAttribute("aria-hidden", "true");

        glCanvas.addEventListener("webglcontextlost", onContextLost, false);
        glCanvas.addEventListener("webglcontextrestored", onContextRestored, false);

        gl = glCanvas.getContext("webgl2", {
            alpha: false,
            antialias: false,
            depth: false,
            stencil: false,
            premultipliedAlpha: false,
            preserveDrawingBuffer: false,
            powerPreference: "low-power",
            desynchronized: USE_DESYNCHRONIZED
        });

        if (!gl) {
            webglFailed = true;
            glCanvas = null;
            return false;
        }

        return initWebGLResources();
    }

    function destroyWebGLCanvas() {
        destroyWebGLResources();
        if (gl) {
            try {
                const ext = gl.getExtension("WEBGL_lose_context");
                if (ext) ext.loseContext();
            } catch { }
            gl = null;
        }
        if (glCanvas) {
            glCanvas.removeEventListener("webglcontextlost", onContextLost, false);
            glCanvas.removeEventListener("webglcontextrestored", onContextRestored, false);
            try { glCanvas.remove(); } catch { }
            glCanvas = null;
        }
        isContextLost = false;
        hasRenderedFrame = false;
        isOverlayVisible = false;
    }

    function attachCanvasToVideo(video) {
        if (!video || !video.parentElement || !ensureWebGLCanvas()) return false;
        if (glCanvas.parentElement !== video.parentElement || glCanvas.previousElementSibling !== video) {
            video.after(glCanvas);
        }
        return true;
    }

    function activateOverlayVisibility() {
        if (isOverlayVisible || !glCanvas || !activeVideo) return;
        glCanvas.style.display = "block";
        // Keep opacity > 0 (0.001 rounds to 0 in 8-bit) so Chromium never pauses video decoding/rVFC
        activeVideo.style.opacity = "0.001";
        isOverlayVisible = true;
    }

    function deactivateOverlayVisibility(freeVram) {
        if (glCanvas && isOverlayVisible) {
            glCanvas.style.display = "none";
        }
        if (activeVideo && activeVideo.style.opacity) {
            activeVideo.style.opacity = "";
        }
        isOverlayVisible = false;
        hasRenderedFrame = false;
        if (freeVram) {
            releaseIdleVram();
        }
    }

    function markLayoutDirty() {
        layoutDirty = true;
        if (
            hasRenderedFrame &&
            activeVideo &&
            activeVideo.paused &&
            isEnabled &&
            currentMode === "auto" &&
            !webglFailed &&
            !isContextLost &&
            layoutRafId === null
        ) {
            layoutRafId = requestAnimationFrame(() => {
                layoutRafId = null;
                if (layoutDirty && activeVideo && activeVideo.paused) {
                    syncCanvasLayout();
                }
            });
        }
    }

    function parsePx(val) {
        if (!val || !val.endsWith("px")) return NaN;
        const n = parseFloat(val);
        return Number.isFinite(n) ? n : NaN;
    }

    function syncCanvasLayout() {
        if (!activeVideo || !activeVideo.isConnected) return false;
        if (!isEnabled || currentMode !== "auto" || webglFailed || isContextLost) return false;
        if (!attachCanvasToVideo(activeVideo)) return false;

        // Zero-reflow fast path: YouTube sets inline px geometry directly on video.style
        const st = activeVideo.style;
        let cssW = parsePx(st.width);
        let cssH = parsePx(st.height);
        let left = parsePx(st.left);
        let top = parsePx(st.top);

        if (!(cssW > 0 && cssH > 0)) {
            cssW = activeVideo.offsetWidth;
            cssH = activeVideo.offsetHeight;
            if (cssW <= 0 || cssH <= 0) return false;
            left = activeVideo.offsetLeft;
            top = activeVideo.offsetTop;
        } else if (Number.isNaN(left) || Number.isNaN(top)) {
            left = activeVideo.offsetLeft;
            top = activeVideo.offsetTop;
        }
        const vTransform = st.transform || "";

        if (left !== cachedLeft) {
            glCanvas.style.left = left + "px";
            cachedLeft = left;
        }
        if (top !== cachedTop) {
            glCanvas.style.top = top + "px";
            cachedTop = top;
        }
        if (cssW !== cachedCssW) {
            glCanvas.style.width = cssW + "px";
            cachedCssW = cssW;
        }
        if (cssH !== cachedCssH) {
            glCanvas.style.height = cssH + "px";
            cachedCssH = cssH;
        }
        if (vTransform !== cachedTransform) {
            glCanvas.style.transform = vTransform;
            cachedTransform = vTransform;
        }

        const vw = activeVideo.videoWidth;
        const vh = activeVideo.videoHeight;
        cachedVideoW = vw;
        cachedVideoH = vh;

        // Backing resolution capped at native video resolution & DPR <= 2
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const physW = Math.max(1, Math.round(cssW * dpr));
        const physH = Math.max(1, Math.round(cssH * dpr));
        const maxScale = (vw > 0 && vh > 0)
            ? Math.min(1, Math.max(vw / physW, vh / physH))
            : 1;
        let targetW = Math.max(1, Math.round(physW * maxScale));
        let targetH = Math.max(1, Math.round(physH * maxScale));

        // Compute object-fit mapping: cover uses UV scale; contain uses sub-viewport (no black-bar shading)
        uvScaleX = 1.0;
        uvScaleY = 1.0;
        uvContain = false;
        vpX = 0;
        vpY = 0;

        if (vw > 0 && vh > 0) {
            const vidAR = vw / vh;
            const boxAR = cssW / cssH;
            if (Math.abs(vidAR - boxAR) > 0.01) {
                if (!cachedObjectFit) {
                    cachedObjectFit = getComputedStyle(activeVideo).objectFit || "fill";
                }
                if (cachedObjectFit === "cover") {
                    if (vidAR > boxAR) {
                        uvScaleX = boxAR / vidAR;
                    } else {
                        uvScaleY = vidAR / boxAR;
                    }
                } else if (cachedObjectFit === "contain") {
                    uvContain = true;
                }
            } else {
                // Clamp fractional-DPR rounding overflow (e.g. 1921x1080 -> 1920x1080) for crisp 1:1 texels
                targetW = Math.min(targetW, vw);
                targetH = Math.min(targetH, vh);
            }
        }

        vpW = targetW;
        vpH = targetH;
        if (uvContain && vw > 0 && vh > 0) {
            const vidAR = vw / vh;
            const boxAR = cssW / cssH;
            if (vidAR > boxAR) {
                vpH = Math.max(1, Math.round(targetW / vidAR));
                vpY = Math.round((targetH - vpH) * 0.5);
            } else {
                vpW = Math.max(1, Math.round(targetH * vidAR));
                vpX = Math.round((targetW - vpW) * 0.5);
            }
        }

        if (gl && programsReady && progPass3 && (uvScaleX !== lastUploadedUvScaleX || uvScaleY !== lastUploadedUvScaleY)) {
            gl.useProgram(progPass3);
            gl.uniform2f(locUvScale, uvScaleX, uvScaleY);
            lastUploadedUvScaleX = uvScaleX;
            lastUploadedUvScaleY = uvScaleY;
        }

        const sizeChanged = (targetW !== cachedTargetW || targetH !== cachedTargetH);
        if (sizeChanged) {
            glCanvas.width = targetW;
            glCanvas.height = targetH;
            cachedTargetW = targetW;
            cachedTargetH = targetH;
        }

        layoutDirty = false;

        if (sizeChanged && hasRenderedFrame && activeVideo.paused && activeVideo.readyState >= 2) {
            redrawDisplayOnly(activeVideo);
        }
        return true;
    }

    function redrawDisplayOnly(video) {
        if (!gl || isContextLost || webglFailed || !programsReady || !progPass3 || !video || video.readyState < 2) return;
        try {
            gl.activeTexture(gl.TEXTURE0);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);

            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            if (uvContain) gl.clear(gl.COLOR_BUFFER_BIT);
            gl.viewport(vpX, vpY, vpW, vpH);
            gl.useProgram(progPass3);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
        } catch {
            handleFatalWebGLError();
        }
    }

    function handleFatalWebGLError() {
        webglFailed = true;
        cancelFrameLoop();
        deactivateOverlayVisibility(false);
    }

    function renderFrame(video, allowWhenPaused, now) {
        if (!isEnabled || currentMode !== "auto" || video !== activeVideo || webglFailed || isContextLost) {
            return false;
        }
        if (!video.isConnected) return false;

        if (document.hidden || !isIntersecting || (!allowWhenPaused && (video.paused || video.ended))) {
            lastFrameTime = 0;
            return false; // Sleep until play/visibility/intersection wakes us
        }

        const vw = video.videoWidth;
        const vh = video.videoHeight;
        if (video.readyState < 2 || !vw || !vh) {
            return true;
        }

        if (layoutDirty || vw !== cachedVideoW || vh !== cachedVideoH) {
            if (!syncCanvasLayout()) return !webglFailed;
        }

        if (!gl || !progPass1 || !progPass2a || !progPass2b || !progPass3) {
            return !webglFailed;
        }

        if (!checkProgramsReady()) {
            if (allowWhenPaused && !webglFailed) {
                scheduleCompilePoll();
            }
            return !webglFailed;
        }

        const ts = now || performance.now();
        const dtMs = (!allowWhenPaused && lastFrameTime > 0)
            ? Math.min(Math.max(ts - lastFrameTime, 0), 250)
            : 16.67;
        lastFrameTime = allowWhenPaused ? 0 : ts;

        try {
            // Upload live video frame onto permanently bound TEXTURE0
            gl.activeTexture(gl.TEXTURE0);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);

            // --- PASS 1: 32x18 parallel downsample + luma diff ---
            // Unit 0 = videoTex, Unit 1 = downTex[downReadIdx] (already bound!)
            gl.bindFramebuffer(gl.FRAMEBUFFER, downFbo[downWriteIdx]);
            gl.viewport(0, 0, 32, 18);
            gl.useProgram(progPass1);
            gl.drawArrays(gl.TRIANGLES, 0, 3);

            // --- PASS 2a: 8x3 parallel tile reduction (24 threads x 4x6 texels -> 3x RGBA32UI MRT) ---
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, downTex[downWriteIdx]);
            gl.bindFramebuffer(gl.FRAMEBUFFER, tileFbo);
            gl.viewport(0, 0, 8, 3);
            gl.useProgram(progPass2a);
            gl.drawArrays(gl.TRIANGLES, 0, 3);

            // --- PASS 2b: 1x1 RGBA32UI detector + SIMD 24-tile merge + scene-cut + strobe guard ---
            // Unit 2 = stateTex[stateReadIdx], Units 3..5 = tileTex[0..2] (permanently bound!)
            gl.bindFramebuffer(gl.FRAMEBUFFER, stateFbo[stateWriteIdx]);
            gl.viewport(0, 0, 1, 1);
            gl.useProgram(progPass2b);
            gl.uniform1f(locDtMs, dtMs);

            const resetInt = needsStateReset ? 1 : 0;
            if (resetInt !== lastSentReset) {
                gl.uniform1i(locResetState, resetInt);
                lastSentReset = resetInt;
            }
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            needsStateReset = false;

            // Swap ping-pong indices (Unit 1 now already holds next frame's downReadIdx!)
            const tmpDown = downReadIdx;
            downReadIdx = downWriteIdx;
            downWriteIdx = tmpDown;

            const tmpState = stateReadIdx;
            stateReadIdx = stateWriteIdx;
            stateWriteIdx = tmpState;

            // --- PASS 3: 0-latency synchronous screen render ---
            // Unit 0 = videoTex, Unit 2 = stateTex[stateReadIdx] (also readied for next frame's Pass 2!)
            gl.activeTexture(gl.TEXTURE2);
            gl.bindTexture(gl.TEXTURE_2D, stateTex[stateReadIdx]);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            if (uvContain) gl.clear(gl.COLOR_BUFFER_BIT);
            gl.viewport(vpX, vpY, vpW, vpH);
            gl.useProgram(progPass3);
            gl.drawArrays(gl.TRIANGLES, 0, 3);

            hasRenderedFrame = true;
            activateOverlayVisibility();
            return true;
        } catch {
            handleFatalWebGLError();
            return false;
        }
    }

    // --- Video Binding & Event-Driven Frame Scheduling ---
    function isWatchPage() {
        return location.pathname === "/watch";
    }

    function isShortsPage() {
        return location.pathname.startsWith("/shorts/");
    }

    function isButtonPage() {
        return isWatchPage() || isShortsPage();
    }

    function isVideoVisibleInDom(v) {
        return Boolean(v && v.isConnected && !v.closest("[hidden]"));
    }

    function findVisibleVideoById(id) {
        const root = document.getElementById(id);
        if (!root) return null;
        const v = root.querySelector("video.html5-main-video");
        return isVideoVisibleInDom(v) ? v : null;
    }

    function getMainVideo() {
        if (isShortsPage()) {
            const sv = findVisibleVideoById("shorts-player");
            if (sv) return sv;
            const activeShortV = document.querySelector("ytd-reel-video-renderer[is-active] video.html5-main-video");
            if (isVideoVisibleInDom(activeShortV)) return activeShortV;
            const mini = document.querySelector("ytd-miniplayer[active] video.html5-main-video");
            if (isVideoVisibleInDom(mini)) return mini;
            return findVisibleVideoById("movie_player");
        }

        const mp = findVisibleVideoById("movie_player");
        if (mp) return mp;
        if (isWatchPage()) {
            const watchV = document.querySelector("ytd-watch-flexy:not([hidden]) #movie_player video.html5-main-video");
            if (isVideoVisibleInDom(watchV)) return watchV;
        }
        const mini = document.querySelector("ytd-miniplayer[active] video.html5-main-video");
        if (isVideoVisibleInDom(mini)) return mini;
        return findVisibleVideoById("shorts-player");
    }

    function clearVideoFilter(video) {
        if (!video) return;
        video.style.filter = "";
        video.style.transitionProperty = "";
        video.style.transitionDuration = "";
        video.style.transitionTimingFunction = "";
    }

    function cancelFrameLoop() {
        if (frameHandle !== null && activeVideo) {
            if (isUsingVfc && typeof activeVideo.cancelVideoFrameCallback === "function") {
                activeVideo.cancelVideoFrameCallback(frameHandle);
            } else {
                cancelAnimationFrame(frameHandle);
            }
            frameHandle = null;
        }
    }

    // Reusable single callback (zero per-frame closure allocation)
    function onFrameCallback(now, metadata) {
        frameHandle = null;
        const video = activeVideo;
        if (!video) return;

        // Deduplicate identical video frames (critical for rAF fallback on 24/30fps video @ 60-240Hz)
        if (metadata) {
            if (metadata.presentedFrames === lastPresentedFrames && hasRenderedFrame && !layoutDirty) {
                scheduleNextFrame(video);
                return;
            }
            lastPresentedFrames = metadata.presentedFrames;
        } else {
            const ct = video.currentTime;
            if (ct === lastVideoTime && hasRenderedFrame && !layoutDirty) {
                if (!video.paused && !video.ended && !document.hidden && isIntersecting) {
                    scheduleNextFrame(video);
                }
                return;
            }
            lastVideoTime = ct;
        }

        const shouldContinue = renderFrame(video, false, now);
        if (shouldContinue) {
            scheduleNextFrame(video);
        }
    }

    function scheduleNextFrame(video) {
        if (
            !isEnabled ||
            currentMode !== "auto" ||
            video !== activeVideo ||
            frameHandle !== null ||
            webglFailed ||
            isContextLost ||
            document.hidden ||
            !isIntersecting ||
            video.paused ||
            video.ended
        ) {
            return;
        }
        if (videoSupportsVfc) {
            isUsingVfc = true;
            frameHandle = video.requestVideoFrameCallback(onFrameCallback);
        } else {
            isUsingVfc = false;
            frameHandle = requestAnimationFrame(onFrameCallback);
        }
    }

    function onVideoPlay() {
        if (isButtonPage() && (!wrapperEl || !wrapperEl.isConnected || wrapperEl.closest("[hidden]"))) {
            ensureMountedWithRetry(6, 100);
        }
        if (isEnabled && currentMode === "auto" && activeVideo && !webglFailed && !isContextLost) {
            lastFrameTime = 0;
            scheduleNextFrame(activeVideo);
        }
    }

    function onVideoPause() {
        cancelFrameLoop();
        lastFrameTime = 0;
    }

    function onVideoEmptied() {
        webglFailed = false;
        needsStateReset = true;
        lastFrameTime = 0;
        lastPresentedFrames = -1;
        lastVideoTime = -1;
        cancelFrameLoop();
        deactivateOverlayVisibility(true);
    }

    function onVideoSeeked() {
        needsStateReset = true;
        lastFrameTime = 0;
        lastPresentedFrames = -1;
        lastVideoTime = -1;
        if (isEnabled && currentMode === "auto" && activeVideo && activeVideo.paused && activeVideo.readyState >= 2) {
            renderFrame(activeVideo, true, performance.now());
        }
    }

    function onVideoLoadedData() {
        if (isButtonPage() && (!wrapperEl || !wrapperEl.isConnected || wrapperEl.closest("[hidden]"))) {
            ensureMountedWithRetry(6, 100);
        }
        if (isEnabled && currentMode === "auto" && activeVideo && !webglFailed && !isContextLost) {
            layoutDirty = true;
            if (activeVideo.paused && activeVideo.readyState >= 2) {
                renderFrame(activeVideo, true, performance.now());
            } else {
                scheduleNextFrame(activeVideo);
            }
        }
    }

    function stopAutoPipeline(freeVram) {
        cancelCompilePoll();
        cancelFrameLoop();
        if (layoutRafId !== null) {
            cancelAnimationFrame(layoutRafId);
            layoutRafId = null;
        }
        deactivateOverlayVisibility(freeVram);
        needsStateReset = true;
        lastFrameTime = 0;
        lastPresentedFrames = -1;
        lastVideoTime = -1;
    }

    function applyFilterState() {
        if (!activeVideo) return;

        if (!isEnabled) {
            stopAutoPipeline(true);
            clearVideoFilter(activeVideo);
            return;
        }

        if (currentMode === "manual") {
            stopAutoPipeline(true);
            activeVideo.style.transitionProperty = "filter";
            activeVideo.style.transitionTimingFunction = "linear";
            activeVideo.style.transitionDuration = "150ms";
            activeVideo.style.filter = "brightness(" + manualGain.toFixed(3) + ")";
        } else {
            clearVideoFilter(activeVideo);
            if (!webglFailed && !isContextLost) {
                needsStateReset = true;
                lastFrameTime = 0;
                lastPresentedFrames = -1;
                lastVideoTime = -1;
                layoutDirty = true;
                if (activeVideo.readyState >= 2) {
                    renderFrame(activeVideo, true, performance.now());
                }
                scheduleNextFrame(activeVideo);
            }
        }
    }

    function resetLayoutCaches() {
        layoutDirty = true;
        cachedCssW = 0;
        cachedCssH = 0;
        cachedLeft = NaN;
        cachedTop = NaN;
        cachedTransform = "";
        cachedObjectFit = "";
        cachedVideoW = 0;
        cachedVideoH = 0;
        lastInlineW = "";
        lastInlineH = "";
        lastInlineL = "";
        lastInlineT = "";
        lastInlineTransform = "";
    }

    function unbindVideo() {
        stopAutoPipeline(true);
        if (activeVideo) {
            clearVideoFilter(activeVideo);
            activeVideo.removeEventListener("play", onVideoPlay);
            activeVideo.removeEventListener("playing", onVideoPlay);
            activeVideo.removeEventListener("pause", onVideoPause);
            activeVideo.removeEventListener("ended", onVideoPause);
            activeVideo.removeEventListener("emptied", onVideoEmptied);
            activeVideo.removeEventListener("seeked", onVideoSeeked);
            activeVideo.removeEventListener("loadeddata", onVideoLoadedData);
            activeVideo.removeEventListener("resize", markLayoutDirty);
        }
        if (videoIntersectionObserver) {
            try { videoIntersectionObserver.disconnect(); } catch { }
            videoIntersectionObserver = null;
        }
        if (videoResizeObserver) {
            try { videoResizeObserver.disconnect(); } catch { }
            videoResizeObserver = null;
        }
        if (videoStyleObserver) {
            try { videoStyleObserver.disconnect(); } catch { }
            videoStyleObserver = null;
        }
        activeVideo = null;
        videoSupportsVfc = false;
        webglFailed = false;
        isIntersecting = true;
        resetLayoutCaches();
    }

    function bindVideo() {
        const video = getMainVideo();
        if (!video) {
            if (activeVideo && !isVideoVisibleInDom(activeVideo)) {
                unbindVideo();
            }
            return;
        }

        if (video === activeVideo) {
            if (isEnabled && currentMode === "manual") {
                video.style.filter = "brightness(" + manualGain.toFixed(3) + ")";
            } else if (isEnabled && currentMode === "auto" && frameHandle === null && !webglFailed && !isContextLost) {
                scheduleNextFrame(video);
            }
            return;
        }

        unbindVideo();
        activeVideo = video;
        videoSupportsVfc = typeof video.requestVideoFrameCallback === "function";
        webglFailed = false;
        needsStateReset = true;
        lastFrameTime = 0;
        lastPresentedFrames = -1;
        lastVideoTime = -1;

        const s = video.style;
        lastInlineW = s.width;
        lastInlineH = s.height;
        lastInlineL = s.left;
        lastInlineT = s.top;
        lastInlineTransform = s.transform;

        video.addEventListener("play", onVideoPlay);
        video.addEventListener("playing", onVideoPlay);
        video.addEventListener("pause", onVideoPause);
        video.addEventListener("ended", onVideoPause);
        video.addEventListener("emptied", onVideoEmptied);
        video.addEventListener("seeked", onVideoSeeked);
        video.addEventListener("loadeddata", onVideoLoadedData);
        video.addEventListener("resize", markLayoutDirty);

        try {
            videoIntersectionObserver = new IntersectionObserver((entries) => {
                if (!entries.length) return;
                const next = entries[entries.length - 1].isIntersecting;
                if (next === isIntersecting) return;
                isIntersecting = next;
                if (isIntersecting) {
                    lastFrameTime = 0;
                    if (isEnabled && currentMode === "auto" && activeVideo && !webglFailed && !isContextLost) {
                        if (activeVideo.paused && layoutDirty && hasRenderedFrame) {
                            syncCanvasLayout();
                        } else {
                            scheduleNextFrame(activeVideo);
                        }
                    }
                } else {
                    cancelFrameLoop();
                    lastFrameTime = 0;
                }
            });
            videoIntersectionObserver.observe(video);
        } catch {
            isIntersecting = true;
        }

        try {
            videoResizeObserver = new ResizeObserver(markLayoutDirty);
            videoResizeObserver.observe(video);
        } catch { }

        try {
            videoStyleObserver = new MutationObserver(() => {
                if (!activeVideo) return;
                const st = activeVideo.style;
                if (
                    st.width !== lastInlineW ||
                    st.height !== lastInlineH ||
                    st.left !== lastInlineL ||
                    st.top !== lastInlineT ||
                    st.transform !== lastInlineTransform
                ) {
                    lastInlineW = st.width;
                    lastInlineH = st.height;
                    lastInlineL = st.left;
                    lastInlineT = st.top;
                    lastInlineTransform = st.transform;
                    markLayoutDirty();
                }
            });
            videoStyleObserver.observe(video, { attributes: true, attributeFilter: ["style"] });
        } catch { }

        applyFilterState();
    }

    // --- UI: Button, Tooltip & Fixed-Portal Settings Popup (Trusted Types Safe, Cached Refs) ---
    function updateButtonAppearance() {
        if (!btnEl) return;
        const key = (isEnabled ? "1" : "0") + "|" + currentMode + "|" + (isPopupOpen ? "1" : "0");
        if (key === lastBtnStateKey) return;
        lastBtnStateKey = key;

        const modeLabel = currentMode === "manual" ? "Manual" : "Auto";
        btnEl.setAttribute("aria-pressed", isEnabled ? "true" : "false");
        btnEl.setAttribute("aria-expanded", isPopupOpen ? "true" : "false");
        if (wrapperEl) wrapperEl.dataset.popupOpen = isPopupOpen ? "true" : "false";
        if (tooltipEl) {
            const stateLabel = isEnabled ? "ON" : "OFF";
            tooltipEl.textContent = `Flashbang Defender: ${stateLabel} (${modeLabel}) • Right-click for settings`;
        }
    }

    function updatePopupUI() {
        if (!popupEl) return;

        if (powerPillEl) {
            powerPillEl.textContent = isEnabled ? "ON" : "OFF";
            powerPillEl.setAttribute("aria-pressed", isEnabled ? "true" : "false");
        }

        const opts = [optAutoEl, optManualEl];
        for (let i = 0; i < opts.length; i++) {
            const opt = opts[i];
            if (!opt) continue;
            const isActive = opt.dataset.mode === currentMode;
            opt.dataset.active = isActive ? "true" : "false";
            opt.setAttribute("aria-checked", isActive ? "true" : "false");
        }

        const isAuto = currentMode === "auto";
        const pct = Math.round((isAuto ? autoSensitivity : manualGain) * 100);
        if (sliderLabelEl) {
            sliderLabelEl.textContent = isAuto ? "Auto Sensitivity" : "Manual Brightness";
        }
        if (sliderInputEl) {
            sliderInputEl.min = isAuto ? String(Math.round(MIN_AUTO_SENSITIVITY * 100)) : String(Math.round(MIN_MANUAL_GAIN * 100));
            sliderInputEl.max = isAuto ? String(Math.round(MAX_AUTO_SENSITIVITY * 100)) : String(Math.round(MAX_MANUAL_GAIN * 100));
            sliderInputEl.value = String(pct);
            sliderInputEl.setAttribute("aria-label", isAuto ? "Auto sensitivity percentage" : "Manual brightness percentage");
            sliderInputEl.setAttribute("aria-valuetext", pct + "%");
            sliderInputEl.disabled = false;
        }
        if (sliderValEl) {
            sliderValEl.textContent = pct + "%";
        }
        if (sliderContEl) {
            sliderContEl.dataset.disabled = "false";
        }
    }

    function syncAllUI() {
        updateButtonAppearance();
        if (popupEl) updatePopupUI();
    }

    function createOrGetPopup() {
        if (popupEl && popupEl.isConnected) {
            updatePopupUI();
            return popupEl;
        }

        ensureStyles();
        document.getElementById("yt-flashbang-defender-popup")?.remove();

        const popup = document.createElement("div");
        popup.id = "yt-flashbang-defender-popup";
        popup.setAttribute("role", "dialog");
        popup.setAttribute("aria-label", "Flashbang Defender Settings");

        popup.addEventListener("click", (e) => e.stopPropagation());
        popup.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
        });

        const header = document.createElement("div");
        header.className = "yt-fbd-popup-header";

        const headerTitle = document.createElement("span");
        headerTitle.textContent = "Flashbang Defender";

        powerPillEl = document.createElement("button");
        powerPillEl.id = "yt-fbd-power-pill";
        powerPillEl.type = "button";
        powerPillEl.setAttribute("aria-label", "Toggle Flashbang Defender");
        powerPillEl.addEventListener("click", () => {
            isEnabled = !isEnabled;
            webglFailed = false;
            saveEnabled(isEnabled);
            applyFilterState();
            syncAllUI();
        });

        header.append(headerTitle, powerPillEl);
        popup.appendChild(header);

        const modeGroup = document.createElement("div");
        modeGroup.className = "yt-fbd-mode-group";
        modeGroup.setAttribute("role", "menu");

        function createOption(modeKey, titleText, descText) {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "yt-fbd-popup-opt";
            item.dataset.mode = modeKey;
            item.setAttribute("role", "menuitemradio");

            const textCol = document.createElement("span");
            textCol.className = "yt-fbd-opt-text";

            const title = document.createElement("span");
            title.className = "yt-fbd-opt-title";
            title.textContent = titleText;

            const desc = document.createElement("span");
            desc.className = "yt-fbd-opt-desc";
            desc.textContent = descText;

            textCol.append(title, desc);
            item.appendChild(textCol);

            const check = document.createElement("span");
            check.className = "yt-fbd-opt-check";
            check.setAttribute("aria-hidden", "true");
            check.textContent = "✓";
            item.appendChild(check);

            item.addEventListener("click", () => {
                currentMode = modeKey;
                saveMode(currentMode);
                if (!isEnabled) {
                    isEnabled = true;
                    saveEnabled(true);
                }
                webglFailed = false;
                applyFilterState();
                syncAllUI();
            });

            return item;
        }

        optAutoEl = createOption("auto", "Automatic", "0-frame GPU shader + scene-cut");
        optManualEl = createOption("manual", "Manual", "Static brightness filter");
        modeGroup.append(optAutoEl, optManualEl);
        popup.appendChild(modeGroup);

        sliderContEl = document.createElement("div");
        sliderContEl.id = "yt-fbd-slider-container";

        const sliderHeader = document.createElement("div");
        sliderHeader.className = "yt-fbd-slider-header";

        sliderLabelEl = document.createElement("label");
        sliderLabelEl.htmlFor = "yt-fbd-slider-input";
        sliderLabelEl.textContent = "Auto Sensitivity";

        sliderValEl = document.createElement("span");
        sliderValEl.id = "yt-fbd-slider-val";

        sliderHeader.append(sliderLabelEl, sliderValEl);
        sliderContEl.appendChild(sliderHeader);

        sliderInputEl = document.createElement("input");
        sliderInputEl.id = "yt-fbd-slider-input";
        sliderInputEl.type = "range";
        sliderInputEl.min = "0";
        sliderInputEl.max = "100";
        sliderInputEl.step = "5";
        sliderInputEl.setAttribute("aria-label", "Auto sensitivity percentage");

        sliderInputEl.addEventListener("input", (e) => {
            const pct = parseInt(e.target.value, 10);
            if (!isEnabled) {
                isEnabled = true;
                saveEnabled(true);
                syncAllUI();
            }

            if (currentMode === "manual") {
                manualGain = clampManualGain(pct / 100);
                const rounded = Math.round(manualGain * 100);
                sliderValEl.textContent = rounded + "%";
                sliderInputEl.setAttribute("aria-valuetext", rounded + "%");
                if (activeVideo) {
                    activeVideo.style.transitionProperty = "filter";
                    activeVideo.style.transitionDuration = "0ms";
                    activeVideo.style.filter = "brightness(" + manualGain.toFixed(3) + ")";
                }
            } else {
                autoSensitivity = clampAutoSensitivity(pct / 100);
                const rounded = Math.round(autoSensitivity * 100);
                sliderValEl.textContent = rounded + "%";
                sliderInputEl.setAttribute("aria-valuetext", rounded + "%");
                uploadSensitivityUniforms();
                needsStateReset = true;
                if (activeVideo && activeVideo.paused && activeVideo.readyState >= 2) {
                    renderFrame(activeVideo, true, performance.now());
                }
            }
        });

        sliderInputEl.addEventListener("change", () => {
            if (currentMode === "manual") {
                saveManualGain(manualGain);
            } else {
                saveAutoSensitivity(autoSensitivity);
            }
        });

        sliderContEl.appendChild(sliderInputEl);
        popup.appendChild(sliderContEl);

        document.body.appendChild(popup);
        popupEl = popup;
        updatePopupUI();
        return popup;
    }

    function positionPopup(popup, btn) {
        const margin = 8;
        popup.style.visibility = "hidden";
        popup.style.display = "flex";

        const rect = btn.getBoundingClientRect();
        const popupW = popup.offsetWidth || 232;
        const popupH = popup.offsetHeight || 190;

        let top = rect.bottom + margin;
        if (top + popupH > window.innerHeight - margin && rect.top - popupH - margin >= margin) {
            top = rect.top - popupH - margin;
        }

        let left = rect.left + (rect.width - popupW) / 2;
        left = Math.max(margin, Math.min(window.innerWidth - popupW - margin, left));

        popup.style.top = Math.round(top) + "px";
        popup.style.left = Math.round(left) + "px";
        popup.style.visibility = "visible";
    }

    function onDocPointerDown(e) {
        const inWrapper = wrapperEl && wrapperEl.contains(e.target);
        const inPopup = popupEl && popupEl.contains(e.target);
        if (!inWrapper && !inPopup) {
            closePopup(false);
        }
    }

    function onDocKeyDown(e) {
        if (e.key === "Escape") {
            e.preventDefault();
            closePopup(true);
        }
    }

    function onPopupScroll(e) {
        if (popupEl && popupEl.contains(e.target)) return;
        closePopup(false);
    }

    function attachPopupDismissListeners() {
        document.addEventListener("pointerdown", onDocPointerDown, true);
        document.addEventListener("keydown", onDocKeyDown);
        window.addEventListener("scroll", onPopupScroll, { capture: true, passive: true });
    }

    function detachPopupDismissListeners() {
        document.removeEventListener("pointerdown", onDocPointerDown, true);
        document.removeEventListener("keydown", onDocKeyDown);
        window.removeEventListener("scroll", onPopupScroll, { capture: true });
    }

    function openPopup() {
        if (!btnEl) return;
        const popup = createOrGetPopup();
        positionPopup(popup, btnEl);
        isPopupOpen = true;
        updateButtonAppearance();
        attachPopupDismissListeners();
    }

    function closePopup(restoreFocus) {
        if (popupEl) {
            popupEl.style.display = "none";
        }
        if (isPopupOpen) {
            isPopupOpen = false;
            detachPopupDismissListeners();
            updateButtonAppearance();
        }
        if (btnEl && restoreFocus) {
            btnEl.focus();
        }
    }

    function togglePopup() {
        if (isPopupOpen) {
            closePopup(false);
        } else {
            openPopup();
        }
    }

    function onWindowResize() {
        markLayoutDirty();
        if (isPopupOpen) closePopup(false);
    }

    // --- Watch & Shorts Page Button Mounting ---
    function findWatchLikeDislikeContainer() {
        const topBar = document.getElementById("top-level-buttons-computed");
        if (topBar && !topBar.closest("[hidden]")) {
            const seg = topBar.querySelector(
                "segmented-like-dislike-button-view-model, ytd-segmented-like-dislike-button-renderer"
            );
            if (seg) return seg;
        }
        return document.querySelector(
            "ytd-watch-metadata segmented-like-dislike-button-view-model, " +
            "ytd-watch-metadata ytd-segmented-like-dislike-button-renderer, " +
            "ytd-watch-flexy:not([hidden]) segmented-like-dislike-button-view-model, " +
            "ytd-watch-flexy:not([hidden]) ytd-segmented-like-dislike-button-renderer"
        );
    }

    function findShortsCommentsAnchor() {
        const selectors = [
            "ytd-reel-video-renderer[is-active] reel-action-bar-view-model > button-view-model",
            "ytd-reel-video-renderer[is-active] #actions #comments-button",
            "ytd-shorts:not([hidden]) reel-action-bar-view-model > button-view-model",
            "ytd-shorts:not([hidden]) #actions #comments-button",
            "ytd-shorts:not([hidden]) reel-action-bar-view-model > like-button-view-model",
            "ytd-shorts:not([hidden]) #actions #like-button"
        ];
        for (let i = 0; i < selectors.length; i++) {
            const el = document.querySelector(selectors[i]);
            if (el && el.isConnected && !el.closest("[hidden]") && el.parentElement) {
                return el;
            }
        }
        return null;
    }

    function findButtonAnchor() {
        if (isWatchPage()) {
            const seg = findWatchLikeDislikeContainer();
            return (seg && seg.parentElement) ? { anchor: seg, layout: "watch" } : null;
        }
        if (isShortsPage()) {
            const comments = findShortsCommentsAnchor();
            return (comments && comments.parentElement) ? { anchor: comments, layout: "shorts" } : null;
        }
        return null;
    }

    function placeWrapperAtTarget(target) {
        if (!wrapperEl || !target || !target.anchor) return;
        if (wrapperEl.dataset.layout !== target.layout) {
            wrapperEl.dataset.layout = target.layout;
        }
        if (wrapperEl.previousElementSibling !== target.anchor) {
            target.anchor.after(wrapperEl);
        }
    }

    function disconnectActionBarObserver() {
        actionBarSyncQueued = false;
        if (actionBarObserver) {
            try { actionBarObserver.disconnect(); } catch { }
            actionBarObserver = null;
            observedActionBar = null;
        }
    }

    function observeActionBar(parent) {
        if (!parent || parent === observedActionBar) return;
        disconnectActionBarObserver();
        observedActionBar = parent;
        actionBarObserver = new MutationObserver(() => {
            if (!isButtonPage()) {
                disconnectActionBarObserver();
                return;
            }
            if (actionBarSyncQueued) return;
            actionBarSyncQueued = true;
            queueMicrotask(() => {
                actionBarSyncQueued = false;
                if (!isButtonPage()) {
                    disconnectActionBarObserver();
                    return;
                }
                if (!wrapperEl || !wrapperEl.isConnected) {
                    insertButton();
                } else {
                    const target = findButtonAnchor();
                    if (target) {
                        placeWrapperAtTarget(target);
                    }
                }
            });
        });
        actionBarObserver.observe(parent, { childList: true });
    }

    function insertButton() {
        if (!isButtonPage()) return false;

        const target = findButtonAnchor();
        if (!target) return false;

        ensureStyles();
        observeActionBar(target.anchor.parentElement);

        if (wrapperEl && wrapperEl.isConnected) {
            placeWrapperAtTarget(target);
            syncAllUI();
            return true;
        }

        document.getElementById("yt-flashbang-defender-wrapper")?.remove();

        wrapperEl = document.createElement("div");
        wrapperEl.id = "yt-flashbang-defender-wrapper";
        wrapperEl.dataset.layout = target.layout;

        btnEl = document.createElement("button");
        btnEl.id = "yt-flashbang-defender-btn";
        btnEl.type = "button";
        btnEl.setAttribute("aria-label", "Flashbang Defender");
        btnEl.setAttribute("aria-haspopup", "dialog");
        btnEl.setAttribute("aria-expanded", "false");

        const svgNS = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(svgNS, "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("width", "22");
        svg.setAttribute("height", "22");
        svg.setAttribute("fill", "none");
        svg.setAttribute("stroke", "currentColor");
        svg.setAttribute("stroke-width", "2");
        svg.setAttribute("stroke-linecap", "round");
        svg.setAttribute("stroke-linejoin", "round");
        svg.setAttribute("aria-hidden", "true");
        svg.style.pointerEvents = "none";

        const polygon = document.createElementNS(svgNS, "polygon");
        polygon.setAttribute("points", "13 2 3 14 12 14 11 22 21 10 12 10 13 2");
        svg.appendChild(polygon);
        btnEl.appendChild(svg);

        dotEl = document.createElement("span");
        dotEl.id = "yt-fbd-green-dot";
        dotEl.setAttribute("aria-hidden", "true");
        btnEl.appendChild(dotEl);

        tooltipEl = document.createElement("div");
        tooltipEl.id = "yt-flashbang-defender-tooltip";
        tooltipEl.setAttribute("role", "tooltip");

        wrapperEl.append(btnEl, tooltipEl);

        btnEl.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            closePopup(false);
            isEnabled = !isEnabled;
            webglFailed = false;
            saveEnabled(isEnabled);
            applyFilterState();
            syncAllUI();
        });

        btnEl.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            togglePopup();
        });

        lastBtnStateKey = "";
        updateButtonAppearance();
        placeWrapperAtTarget(target);
        return true;
    }

    function ensureMountedWithRetry(attemptsLeft, delayMs) {
        clearTimeout(mountRetryTimer);
        mountRetryTimer = null;

        bindVideo();
        const needsButton = isButtonPage();
        const buttonReady = !needsButton || insertButton();
        const videoReady = Boolean(activeVideo);

        if (!needsButton && !videoReady) {
            // Non-video pages (Home/Search/etc.) only need a short retry in case miniplayer mounts
            if (attemptsLeft > 2) attemptsLeft = 2;
        }

        if ((!buttonReady || !videoReady) && attemptsLeft > 0) {
            const nextDelay = Math.min(1000, Math.round(delayMs * 1.25));
            mountRetryTimer = setTimeout(() => {
                ensureMountedWithRetry(attemptsLeft - 1, nextDelay);
            }, delayMs);
        }
    }

    function onNavigate() {
        const href = location.href;
        const urlChanged = href !== lastNavUrl;
        lastNavUrl = href;

        if (!urlChanged) {
            // Non-navigation yt-player-updated / yt-page-data-updated: skip if already cleanly mounted
            if (isVideoVisibleInDom(activeVideo) && (!isButtonPage() || (wrapperEl && wrapperEl.isConnected && !wrapperEl.closest("[hidden]")))) {
                return;
            }
        } else {
            closePopup(false);
            if (!isButtonPage()) {
                disconnectActionBarObserver();
            }
            webglFailed = false;
            needsStateReset = true;
            lastFrameTime = 0;
            lastPresentedFrames = -1;
            lastVideoTime = -1;
        }

        clearTimeout(navTimer);
        navTimer = setTimeout(() => {
            navTimer = null;
            ensureMountedWithRetry(16, 150);
        }, 150);
    }

    function onVisibilityChange() {
        if (document.hidden) {
            cancelFrameLoop();
            lastFrameTime = 0;
            return;
        }
        if (isButtonPage() && (!wrapperEl || !wrapperEl.isConnected || wrapperEl.closest("[hidden]"))) {
            ensureMountedWithRetry(8, 200);
        }
        if (isEnabled && currentMode === "auto" && activeVideo && !webglFailed && !isContextLost) {
            if (activeVideo.paused && layoutDirty && hasRenderedFrame) {
                syncCanvasLayout();
            } else {
                scheduleNextFrame(activeVideo);
            }
        }
    }

    function onFullscreenChange() {
        cachedObjectFit = "";
        markLayoutDirty();
    }

    function stopAll() {
        unbindVideo();
        destroyWebGLCanvas();
        closePopup(false);

        if (popupEl) {
            try { popupEl.remove(); } catch { }
            popupEl = null;
        }
        powerPillEl = optAutoEl = optManualEl = sliderContEl = sliderLabelEl = sliderInputEl = sliderValEl = null;

        if (wrapperEl) {
            try { wrapperEl.remove(); } catch { }
            wrapperEl = null;
        }
        btnEl = dotEl = tooltipEl = null;
        lastBtnStateKey = "";

        if (styleEl) {
            try { styleEl.remove(); } catch { }
            styleEl = null;
        }

        document.getElementById("yt-flashbang-defender-wrapper")?.remove();
        document.getElementById("yt-fbd-webgl-canvas")?.remove();
        document.getElementById("yt-fbd-styles")?.remove();

        disconnectActionBarObserver();

        clearTimeout(navTimer);
        clearTimeout(mountRetryTimer);
        navTimer = mountRetryTimer = null;

        document.removeEventListener("visibilitychange", onVisibilityChange);
        document.removeEventListener("fullscreenchange", onFullscreenChange);
        window.removeEventListener("resize", onWindowResize);
        window.removeEventListener("yt-navigate-finish", onNavigate);
        window.removeEventListener("yt-page-data-updated", onNavigate);
        window.removeEventListener("yt-player-updated", onNavigate);
    }

    window.__YT_FBD_STOP__ = stopAll;

    document.addEventListener("visibilitychange", onVisibilityChange);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    window.addEventListener("resize", onWindowResize, { passive: true });
    window.addEventListener("yt-navigate-finish", onNavigate);
    window.addEventListener("yt-page-data-updated", onNavigate);
    window.addEventListener("yt-player-updated", onNavigate);

    // Defensively remove any leftover DOM elements
    document.getElementById("yt-flashbang-defender-wrapper")?.remove();
    document.getElementById("yt-flashbang-defender-popup")?.remove();
    document.getElementById("yt-fbd-webgl-canvas")?.remove();
    document.getElementById("yt-fbd-styles")?.remove();

    ensureMountedWithRetry(16, 150);
})();