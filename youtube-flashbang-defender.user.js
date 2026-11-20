// ==UserScript==
// @name         YouTube - Flashbang Defender
// @namespace    https://github.com/EndzE
// @version      1.2.0
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

(function() {
    "use strict";

    // Teardown any previous instance in the same execution context
    if (typeof window.__YT_FBD_STOP__ === "function") {
        try { window.__YT_FBD_STOP__(); } catch {}
    }

    // --- Persistence (single backend, always validated) ---
    const STORAGE_KEY_ENABLED = "yt_flashbang_defender_enabled";
    const STORAGE_KEY_MODE = "yt_flashbang_defender_mode";
    const STORAGE_KEY_MANUAL_GAIN = "yt_flashbang_defender_manual_gain";

    const MIN_MANUAL_GAIN = 0.10;
    const MAX_MANUAL_GAIN = 0.95;
    const DEFAULT_MANUAL_GAIN = 0.60;

    function clampManualGain(val) {
        const num = typeof val === "number" ? val : parseFloat(val);
        if (!Number.isFinite(num)) return DEFAULT_MANUAL_GAIN;
        return Math.min(MAX_MANUAL_GAIN, Math.max(MIN_MANUAL_GAIN, num));
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
        } catch {}
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

    let isEnabled = getSavedEnabled();
    let currentMode = getSavedMode(); // "auto" | "manual"
    let manualGain = getSavedManualGain(); // 0.10 - 0.95

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

    // Pass 2 FS: 1x1 RGBA32UI detector + register-packed 32-bin histogram + scene-cut + strobe guard
    // State uvec4:
    //   r: floatBitsToUint(gain)
    //   g: floatBitsToUint(baseline)
    //   b: packUnorm2x16(vec2(holdRemaining, strobeHeat))
    //   a: flags bitmask (bit0=hasBaseline, bit1=wasFlashing, bit2=hasPrevDown)
    const PASS2_FRAG_SRC = `#version 300 es
precision highp float;
precision highp int;

uniform mediump sampler2D uCurrDown;
uniform highp usampler2D uPrevState;
uniform float uDtMs;
uniform int uResetState;

out uvec4 outState;

const float MIN_ACTIVE_PIXELS     = 144.0;
const float WHITE_PIXEL_THRESHOLD = 180.0 / 255.0;
const float SUSTAINED_WHITE_PEAK  = 220.0 / 255.0;
const float SUSTAINED_WHITE_MEAN  = 120.0 / 255.0;
const float SUSTAINED_WHITE_RATIO = 0.30;
const float MAX_WHITE_LUMA        = 140.0 / 255.0;
const float FLASH_WHITE_PEAK      = 200.0 / 255.0;
const float FLASH_WHITE_DELTA     = 35.0 / 255.0;
const float FLASH_WHITE_RATIO     = 0.20;
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
    if (hi > 0 && taken < topCount) {
        int take = min(hi, topCount - taken);
        peakSum += take * (baseBin + 1);
        taken += take;
    }
    int lo = int(packed & 0xFFFFu);
    if (lo > 0 && taken < topCount) {
        int take = min(lo, topCount - taken);
        peakSum += take * baseBin;
        taken += take;
    }
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

    // 32 histogram bins packed as 2x16-bit counters per uint across 4 uvec4 registers (zero local-memory spill)
    uvec4 h0 = uvec4(0u);
    uvec4 h1 = uvec4(0u);
    uvec4 h2 = uvec4(0u);
    uvec4 h3 = uvec4(0u);

    float totalWhite = 0.0;
    float whitePixelCount = 0.0;
    float activePixels = 0.0;
    float frameDiff = 0.0;
    float diffActivePixels = 0.0;

    for (int y = 0; y < 18; y++) {
        for (int x = 0; x < 32; x++) {
            vec4 currS = texelFetch(uCurrDown, ivec2(x, y), 0);
            if (currS.g < 0.2) continue;

            diffActivePixels += 1.0;
            frameDiff += currS.a;

            if (currS.g < 0.5) continue;

            float w = currS.r;
            activePixels += 1.0;
            totalWhite += w;
            whitePixelCount += step(WHITE_PIXEL_THRESHOLD, w);

            uint bin = min(uint(w * 31.0 + 0.5), 31u);
            uint addVal = ((bin & 1u) == 0u) ? 1u : 65536u;
            uint slot = bin >> 1u;
            uvec4 mask = uvec4(equal(uvec4(slot & 3u), uvec4(0u, 1u, 2u, 3u))) * addVal;
            uint grp = slot >> 2u;
            if (grp < 2u) {
                if (grp == 0u) h0 += mask;
                else h1 += mask;
            } else {
                if (grp == 2u) h2 += mask;
                else h3 += mask;
            }
        }
    }

    float denom = max(activePixels, MIN_ACTIVE_PIXELS);
    int topCount = max(1, int(floor(denom * 0.10 + 0.5)));

    int taken = 0;
    int peakSum = 0;
    consumePair(h3.w, 30, topCount, taken, peakSum);
    consumePair(h3.z, 28, topCount, taken, peakSum);
    consumePair(h3.y, 26, topCount, taken, peakSum);
    consumePair(h3.x, 24, topCount, taken, peakSum);
    if (taken < topCount) {
        consumePair(h2.w, 22, topCount, taken, peakSum);
        consumePair(h2.z, 20, topCount, taken, peakSum);
        consumePair(h2.y, 18, topCount, taken, peakSum);
        consumePair(h2.x, 16, topCount, taken, peakSum);
    }
    if (taken < topCount) {
        consumePair(h1.w, 14, topCount, taken, peakSum);
        consumePair(h1.z, 12, topCount, taken, peakSum);
        consumePair(h1.y, 10, topCount, taken, peakSum);
        consumePair(h1.x,  8, topCount, taken, peakSum);
    }
    if (taken < topCount) {
        consumePair(h0.w,  6, topCount, taken, peakSum);
        consumePair(h0.z,  4, topCount, taken, peakSum);
        consumePair(h0.y,  2, topCount, taken, peakSum);
        consumePair(h0.x,  0, topCount, taken, peakSum);
    }

    float whiteMean = totalWhite / denom;
    float whitePeak = (taken > 0) ? (float(peakSum) / (float(taken) * 31.0)) : 0.0;
    float whiteRatio = whitePixelCount / denom;

    float diffDenom = max(diffActivePixels, MIN_ACTIVE_PIXELS);
    float meanFrameDiff = hasPrevDown ? (frameDiff / diffDenom) : 0.0;
    bool isSceneCut = hasPrevDown && (meanFrameDiff >= SCENE_CUT_DIFF);

    bool isSustainedWhite =
        (whitePeak >= SUSTAINED_WHITE_PEAK) &&
        (whiteMean >= SUSTAINED_WHITE_MEAN) &&
        (whiteRatio >= SUSTAINED_WHITE_RATIO);

    bool isSuddenFlash =
        hasBaseline &&
        (whitePeak >= FLASH_WHITE_PEAK) &&
        ((whitePeak - baseline) >= FLASH_WHITE_DELTA) &&
        (whiteRatio >= FLASH_WHITE_RATIO);

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
            smoothstep(0.08, 0.22, whiteRatio),
            smoothstep(0.32, 0.48, whiteMean)
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
    let progPass2 = null;
    let progPass3 = null;
    let locDtMs = null;
    let locResetState = null;
    let locUvScale = null;

    let videoTex = null;
    let downTex = [null, null];
    let downFbo = [null, null];
    let downReadIdx = 0;
    let downWriteIdx = 1;

    let stateTex = [null, null];
    let stateFbo = [null, null];
    let stateReadIdx = 0;
    let stateWriteIdx = 1;

    // Cached GL uniform / viewport state
    let lastSentReset = -1;
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
    let frameHandle = null;
    let isUsingVfc = false;
    let isIntersecting = true;

    let navTimer = null;
    let mountRetryTimer = null;
    let fsTimer1 = null;
    let fsTimer2 = null;

    let videoIntersectionObserver = null;
    let videoResizeObserver = null;
    let videoStyleObserver = null;
    let actionBarObserver = null;
    let observedActionBar = null;

    // Cached UI element references
    let wrapperEl = null;
    let btnEl = null;
    let dotEl = null;
    let tooltipEl = null;
    let popupEl = null;
    let powerPillEl = null;
    let optAutoEl = null;
    let optManualEl = null;
    let sliderContEl = null;
    let sliderInputEl = null;
    let sliderValEl = null;
    let isPopupOpen = false;

    const USE_DESYNCHRONIZED = !/Android|CrOS/i.test(navigator.userAgent);

    // --- WebGL2 Setup & Teardown ---
    function compileShader(context, type, src) {
        const shader = context.createShader(type);
        context.shaderSource(shader, src);
        context.compileShader(shader);
        if (!context.getShaderParameter(shader, context.COMPILE_STATUS)) {
            const log = context.getShaderInfoLog(shader);
            context.deleteShader(shader);
            throw new Error("Shader compile error: " + log);
        }
        return shader;
    }

    function createProgram(context, vertSrc, fragSrc) {
        const vs = compileShader(context, context.VERTEX_SHADER, vertSrc);
        const fs = compileShader(context, context.FRAGMENT_SHADER, fragSrc);
        const prog = context.createProgram();
        context.attachShader(prog, vs);
        context.attachShader(prog, fs);
        context.linkProgram(prog);
        context.deleteShader(vs);
        context.deleteShader(fs);
        if (!context.getProgramParameter(prog, context.LINK_STATUS)) {
            const log = context.getProgramInfoLog(prog);
            context.deleteProgram(prog);
            throw new Error("Program link error: " + log);
        }
        return prog;
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

    function initWebGLResources() {
        if (!gl) return false;
        try {
            glVao = gl.createVertexArray();
            gl.bindVertexArray(glVao); // Permanently bound for this private context

            progPass1 = createProgram(gl, VERT_PASS1_SRC, PASS1_FRAG_SRC);
            progPass2 = createProgram(gl, VERT_PASS2_SRC, PASS2_FRAG_SRC);
            progPass3 = createProgram(gl, VERT_PASS3_SRC, PASS3_FRAG_SRC);

            // Dedicated persistent texture units:
            //   Unit 0: videoTex (never rebound)
            //   Unit 1: downTex ping-pong
            //   Unit 2: stateTex ping-pong
            gl.useProgram(progPass1);
            gl.uniform1i(gl.getUniformLocation(progPass1, "uVideo"), 0);
            gl.uniform1i(gl.getUniformLocation(progPass1, "uPrevDown"), 1);

            gl.useProgram(progPass2);
            gl.uniform1i(gl.getUniformLocation(progPass2, "uCurrDown"), 1);
            gl.uniform1i(gl.getUniformLocation(progPass2, "uPrevState"), 2);
            locDtMs = gl.getUniformLocation(progPass2, "uDtMs");
            locResetState = gl.getUniformLocation(progPass2, "uResetState");

            gl.useProgram(progPass3);
            gl.uniform1i(gl.getUniformLocation(progPass3, "uVideo"), 0);
            gl.uniform1i(gl.getUniformLocation(progPass3, "uState"), 2);
            locUvScale = gl.getUniformLocation(progPass3, "uUvScale");
            gl.uniform2f(locUvScale, 1.0, 1.0);
            lastUploadedUvScaleX = 1.0;
            lastUploadedUvScaleY = 1.0;
            gl.useProgram(null);

            videoTex = createVideoTexture(gl);

            downTex[0] = createImmutableTexture(gl, gl.RGBA8, 32, 18, gl.NEAREST);
            downTex[1] = createImmutableTexture(gl, gl.RGBA8, 32, 18, gl.NEAREST);
            downFbo[0] = createFbo(gl, downTex[0]);
            downFbo[1] = createFbo(gl, downTex[1]);

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

            // Establish persistent unit bindings
            gl.activeTexture(gl.TEXTURE2);
            gl.bindTexture(gl.TEXTURE_2D, stateTex[0]);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, downTex[0]);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, videoTex);

            gl.clearColor(0.0, 0.0, 0.0, 1.0);
            gl.disable(gl.DEPTH_TEST);
            gl.disable(gl.BLEND);
            return true;
        } catch {
            webglFailed = true;
            destroyWebGLResources();
            return false;
        }
    }

    function destroyWebGLResources() {
        if (gl && !gl.isContextLost()) {
            try {
                if (videoTex) gl.deleteTexture(videoTex);
                if (downTex[0]) gl.deleteTexture(downTex[0]);
                if (downTex[1]) gl.deleteTexture(downTex[1]);
                if (downFbo[0]) gl.deleteFramebuffer(downFbo[0]);
                if (downFbo[1]) gl.deleteFramebuffer(downFbo[1]);
                if (stateTex[0]) gl.deleteTexture(stateTex[0]);
                if (stateTex[1]) gl.deleteTexture(stateTex[1]);
                if (stateFbo[0]) gl.deleteFramebuffer(stateFbo[0]);
                if (stateFbo[1]) gl.deleteFramebuffer(stateFbo[1]);
                if (progPass1) gl.deleteProgram(progPass1);
                if (progPass2) gl.deleteProgram(progPass2);
                if (progPass3) gl.deleteProgram(progPass3);
                if (glVao) gl.deleteVertexArray(glVao);
            } catch {}
        }
        glVao = null;
        progPass1 = progPass2 = progPass3 = null;
        videoTex = null;
        downTex = [null, null];
        downFbo = [null, null];
        stateTex = [null, null];
        stateFbo = [null, null];
        locDtMs = locResetState = locUvScale = null;
        lastSentReset = -1;
        lastUploadedUvScaleX = NaN;
        lastUploadedUvScaleY = NaN;
    }

    function releaseIdleVram() {
        if (!glCanvas || !gl || isContextLost) return;
        try {
            gl.activeTexture(gl.TEXTURE0);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        } catch {}
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

    function ensureWebGLCanvas() {
        if (glCanvas && gl) return true;
        if (webglFailed) return false;

        glCanvas = document.createElement("canvas");
        glCanvas.id = "yt-fbd-webgl-canvas";
        glCanvas.setAttribute("aria-hidden", "true");
        glCanvas.style.cssText = `
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
        `;

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
            } catch {}
            gl = null;
        }
        if (glCanvas) {
            glCanvas.removeEventListener("webglcontextlost", onContextLost, false);
            glCanvas.removeEventListener("webglcontextrestored", onContextRestored, false);
            try { glCanvas.remove(); } catch {}
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

    function syncCanvasLayout() {
        if (!activeVideo || !activeVideo.isConnected) return false;
        if (!isEnabled || currentMode !== "auto" || webglFailed || isContextLost) return false;
        if (!attachCanvasToVideo(activeVideo)) return false;

        const cssW = activeVideo.offsetWidth;
        const cssH = activeVideo.offsetHeight;
        if (cssW <= 0 || cssH <= 0) return false;

        const left = activeVideo.offsetLeft;
        const top = activeVideo.offsetTop;
        const vTransform = activeVideo.style.transform || "";

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
        const targetW = Math.max(1, Math.round(physW * maxScale));
        const targetH = Math.max(1, Math.round(physH * maxScale));

        // Compute object-fit mapping: cover uses UV scale; contain uses sub-viewport (no black-bar shading)
        uvScaleX = 1.0;
        uvScaleY = 1.0;
        uvContain = false;
        vpX = 0;
        vpY = 0;
        vpW = targetW;
        vpH = targetH;

        if (vw > 0 && vh > 0) {
            const vidAR = vw / vh;
            const boxAR = cssW / cssH;
            if (Math.abs(vidAR - boxAR) > 0.01) {
                const fit = getComputedStyle(activeVideo).objectFit;
                if (fit === "cover") {
                    if (vidAR > boxAR) {
                        uvScaleX = boxAR / vidAR;
                    } else {
                        uvScaleY = vidAR / boxAR;
                    }
                } else if (fit === "contain") {
                    uvContain = true;
                    if (vidAR > boxAR) {
                        vpH = Math.max(1, Math.round(targetW / vidAR));
                        vpY = Math.round((targetH - vpH) * 0.5);
                    } else {
                        vpW = Math.max(1, Math.round(targetH * vidAR));
                        vpX = Math.round((targetW - vpW) * 0.5);
                    }
                }
            }
        }

        if (gl && progPass3 && (uvScaleX !== lastUploadedUvScaleX || uvScaleY !== lastUploadedUvScaleY)) {
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
        if (!gl || isContextLost || webglFailed || !progPass3 || !video || video.readyState < 2) return;
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

        if (!gl || !progPass1 || !progPass2 || !progPass3) {
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

            // --- PASS 2: 1x1 RGBA32UI detector + scene-cut + strobe guard ---
            // Unit 1 = downTex[downWriteIdx], Unit 2 = stateTex[stateReadIdx] (already bound!)
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, downTex[downWriteIdx]);
            gl.bindFramebuffer(gl.FRAMEBUFFER, stateFbo[stateWriteIdx]);
            gl.viewport(0, 0, 1, 1);
            gl.useProgram(progPass2);
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

    function isVideoVisibleInDom(v) {
        return Boolean(v && v.isConnected && !v.closest("[hidden]"));
    }

    function getMainVideo() {
        const selectors = isShortsPage()
            ? [
                "#shorts-player video.html5-main-video",
                "ytd-miniplayer[active] video.html5-main-video",
                "#movie_player video.html5-main-video"
            ]
            : [
                "ytd-watch-flexy:not([hidden]) #movie_player video.html5-main-video",
                "#movie_player video.html5-main-video",
                "ytd-miniplayer[active] video.html5-main-video",
                "#shorts-player video.html5-main-video"
            ];

        for (let i = 0; i < selectors.length; i++) {
            const v = document.querySelector(selectors[i]);
            if (isVideoVisibleInDom(v)) return v;
        }
        return null;
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
        if (typeof video.requestVideoFrameCallback === "function") {
            isUsingVfc = true;
            frameHandle = video.requestVideoFrameCallback(onFrameCallback);
        } else {
            isUsingVfc = false;
            frameHandle = requestAnimationFrame(onFrameCallback);
        }
    }

    function onVideoPlay() {
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
            try { videoIntersectionObserver.disconnect(); } catch {}
            videoIntersectionObserver = null;
        }
        if (videoResizeObserver) {
            try { videoResizeObserver.disconnect(); } catch {}
            videoResizeObserver = null;
        }
        if (videoStyleObserver) {
            try { videoStyleObserver.disconnect(); } catch {}
            videoStyleObserver = null;
        }
        activeVideo = null;
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
            if (video.parentElement) videoResizeObserver.observe(video.parentElement);
        } catch {}

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
        } catch {}

        applyFilterState();
    }

    // --- UI: Button, Tooltip & Fixed-Portal Settings Popup (Trusted Types Safe, Cached Refs) ---
    function updateButtonAppearance() {
        if (!btnEl) return;
        const modeLabel = currentMode === "manual" ? "Manual" : "Auto • WebGL2";
        btnEl.setAttribute("aria-pressed", isEnabled ? "true" : "false");
        btnEl.setAttribute("aria-expanded", isPopupOpen ? "true" : "false");
        if (dotEl) dotEl.style.display = isEnabled ? "block" : "none";
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
            powerPillEl.style.backgroundColor = isEnabled ? "rgba(0, 230, 118, 0.18)" : "rgba(255, 255, 255, 0.1)";
            powerPillEl.style.color = isEnabled ? "#00e676" : "rgba(255, 255, 255, 0.65)";
        }

        const opts = [optAutoEl, optManualEl];
        for (let i = 0; i < opts.length; i++) {
            const opt = opts[i];
            if (!opt) continue;
            const isActive = opt.dataset.mode === currentMode;
            opt.dataset.active = isActive ? "true" : "false";
            opt.setAttribute("aria-checked", isActive ? "true" : "false");
            opt.style.backgroundColor = isActive ? "rgba(255, 255, 255, 0.08)" : "transparent";
            if (opt._checkEl) opt._checkEl.style.opacity = isActive ? "1" : "0";
        }

        const pct = Math.round(manualGain * 100);
        if (sliderInputEl) {
            sliderInputEl.value = String(pct);
            sliderInputEl.setAttribute("aria-valuetext", pct + "%");
            sliderInputEl.disabled = currentMode !== "manual";
        }
        if (sliderValEl) {
            sliderValEl.textContent = pct + "%";
        }
        if (sliderContEl) {
            sliderContEl.style.opacity = currentMode === "manual" ? "1" : "0.4";
            sliderContEl.style.pointerEvents = currentMode === "manual" ? "auto" : "none";
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

        document.getElementById("yt-flashbang-defender-popup")?.remove();

        const popup = document.createElement("div");
        popup.id = "yt-flashbang-defender-popup";
        popup.setAttribute("role", "dialog");
        popup.setAttribute("aria-label", "Flashbang Defender Settings");
        popup.style.cssText = `
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
            backdrop-filter: blur(8px);
            z-index: 2147483647;
            display: none;
            flex-direction: column;
            gap: 2px;
            user-select: none;
            box-sizing: border-box;
        `;

        popup.addEventListener("click", (e) => e.stopPropagation());
        popup.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
        });

        const header = document.createElement("div");
        header.style.cssText = `
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
        `;

        const headerTitle = document.createElement("span");
        headerTitle.textContent = "Defender • WebGL2";

        powerPillEl = document.createElement("button");
        powerPillEl.id = "yt-fbd-power-pill";
        powerPillEl.type = "button";
        powerPillEl.setAttribute("aria-label", "Toggle Flashbang Defender");
        powerPillEl.style.cssText = `
            border: none;
            border-radius: 999px;
            padding: 2px 8px;
            font-family: inherit;
            font-size: 10px;
            font-weight: 600;
            letter-spacing: 0.4px;
            cursor: pointer;
            transition: background-color 0.15s ease, color 0.15s ease;
        `;
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
        modeGroup.setAttribute("role", "menu");
        modeGroup.style.cssText = `display: flex; flex-direction: column; gap: 2px;`;

        function createOption(modeKey, titleText, descText) {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "yt-fbd-popup-opt";
            item.dataset.mode = modeKey;
            item.setAttribute("role", "menuitemradio");
            item.style.cssText = `
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
            `;

            const textCol = document.createElement("span");
            textCol.style.cssText = `display: flex; flex-direction: column; gap: 2px;`;

            const title = document.createElement("span");
            title.style.cssText = `font-size: 13px; font-weight: 500; color: #ffffff;`;
            title.textContent = titleText;

            const desc = document.createElement("span");
            desc.style.cssText = `font-size: 11px; color: rgba(255, 255, 255, 0.6);`;
            desc.textContent = descText;

            textCol.append(title, desc);
            item.appendChild(textCol);

            const check = document.createElement("span");
            check.className = "yt-fbd-opt-check";
            check.setAttribute("aria-hidden", "true");
            check.style.cssText = `
                font-size: 14px;
                font-weight: 700;
                color: #00e676;
                margin-left: 8px;
                opacity: 0;
                transition: opacity 0.15s ease;
            `;
            check.textContent = "✓";
            item.appendChild(check);
            item._checkEl = check;

            item.addEventListener("mouseenter", () => {
                item.style.backgroundColor = "rgba(255, 255, 255, 0.12)";
            });
            item.addEventListener("mouseleave", () => {
                item.style.backgroundColor = item.dataset.active === "true"
                    ? "rgba(255, 255, 255, 0.08)"
                    : "transparent";
            });

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
                if (modeKey === "auto") {
                    closePopup(false);
                }
            });

            return item;
        }

        optAutoEl = createOption("auto", "Automatic", "0-frame GPU + scene-cut");
        optManualEl = createOption("manual", "Manual", "Static brightness filter");
        modeGroup.append(optAutoEl, optManualEl);
        popup.appendChild(modeGroup);

        sliderContEl = document.createElement("div");
        sliderContEl.id = "yt-fbd-slider-container";
        sliderContEl.style.cssText = `
            margin-top: 6px;
            padding: 6px 10px 4px 10px;
            border-top: 1px solid rgba(255, 255, 255, 0.08);
            display: flex;
            flex-direction: column;
            gap: 4px;
            transition: opacity 0.2s ease;
        `;

        const sliderHeader = document.createElement("div");
        sliderHeader.style.cssText = `
            display: flex;
            justify-content: space-between;
            font-size: 11px;
            color: rgba(255, 255, 255, 0.7);
        `;

        const sliderLabel = document.createElement("label");
        sliderLabel.htmlFor = "yt-fbd-slider-input";
        sliderLabel.textContent = "Manual Brightness";

        sliderValEl = document.createElement("span");
        sliderValEl.id = "yt-fbd-slider-val";
        sliderValEl.style.fontWeight = "600";
        sliderValEl.style.color = "#00e676";

        sliderHeader.append(sliderLabel, sliderValEl);
        sliderContEl.appendChild(sliderHeader);

        sliderInputEl = document.createElement("input");
        sliderInputEl.id = "yt-fbd-slider-input";
        sliderInputEl.type = "range";
        sliderInputEl.min = String(Math.round(MIN_MANUAL_GAIN * 100));
        sliderInputEl.max = String(Math.round(MAX_MANUAL_GAIN * 100));
        sliderInputEl.step = "5";
        sliderInputEl.setAttribute("aria-label", "Manual brightness percentage");
        sliderInputEl.style.cssText = `
            width: 100%;
            margin: 4px 0 2px 0;
            accent-color: #00e676;
            cursor: pointer;
        `;

        sliderInputEl.addEventListener("input", (e) => {
            const pct = parseInt(e.target.value, 10);
            manualGain = clampManualGain(pct / 100);
            const rounded = Math.round(manualGain * 100);
            sliderValEl.textContent = rounded + "%";
            sliderInputEl.setAttribute("aria-valuetext", rounded + "%");

            if (!isEnabled) {
                isEnabled = true;
                saveEnabled(true);
                syncAllUI();
            }
            if (currentMode === "manual" && activeVideo) {
                activeVideo.style.transitionProperty = "filter";
                activeVideo.style.transitionDuration = "0ms";
                activeVideo.style.filter = "brightness(" + manualGain.toFixed(3) + ")";
            }
        });

        sliderInputEl.addEventListener("change", () => {
            saveManualGain(manualGain);
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
        btnEl.setAttribute("aria-expanded", "true");
        attachPopupDismissListeners();

        if (tooltipEl) {
            tooltipEl.style.opacity = "0";
            tooltipEl.style.visibility = "hidden";
        }
    }

    function closePopup(restoreFocus) {
        if (popupEl) {
            popupEl.style.display = "none";
        }
        if (isPopupOpen) {
            isPopupOpen = false;
            detachPopupDismissListeners();
        }
        if (btnEl) {
            btnEl.setAttribute("aria-expanded", "false");
            if (restoreFocus) btnEl.focus();
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

    // --- Watch Page Button Mounting ---
    function findLikeDislikeContainer() {
        return (
            document.querySelector(
                "ytd-watch-metadata #top-level-buttons-computed segmented-like-dislike-button-view-model, " +
                "ytd-watch-metadata ytd-segmented-like-dislike-button-renderer"
            ) ||
            document.querySelector(
                "ytd-watch-flexy:not([hidden]) segmented-like-dislike-button-view-model, " +
                "ytd-watch-flexy:not([hidden]) ytd-segmented-like-dislike-button-renderer"
            )
        );
    }

    function disconnectActionBarObserver() {
        if (actionBarObserver) {
            try { actionBarObserver.disconnect(); } catch {}
            actionBarObserver = null;
            observedActionBar = null;
        }
    }

    function observeActionBar(parent) {
        if (!parent || parent === observedActionBar) return;
        disconnectActionBarObserver();
        observedActionBar = parent;
        actionBarObserver = new MutationObserver(() => {
            if (!isWatchPage()) {
                disconnectActionBarObserver();
                return;
            }
            if (!wrapperEl || !wrapperEl.isConnected) {
                insertButton();
            }
        });
        actionBarObserver.observe(parent, { childList: true });
    }

    function insertButton() {
        if (!isWatchPage()) return false;

        const segmented = findLikeDislikeContainer();
        if (!segmented || !segmented.parentElement) return false;

        observeActionBar(segmented.parentElement);

        if (wrapperEl && wrapperEl.isConnected) {
            if (wrapperEl.previousElementSibling !== segmented) {
                segmented.after(wrapperEl);
            }
            syncAllUI();
            return true;
        }

        document.getElementById("yt-flashbang-defender-wrapper")?.remove();

        wrapperEl = document.createElement("div");
        wrapperEl.id = "yt-flashbang-defender-wrapper";
        wrapperEl.style.cssText = `
            position: relative;
            display: inline-flex;
            align-items: center;
            margin: 0 8px;
            flex-shrink: 0;
            vertical-align: middle;
            height: 40px;
        `;

        btnEl = document.createElement("button");
        btnEl.id = "yt-flashbang-defender-btn";
        btnEl.type = "button";
        btnEl.setAttribute("aria-label", "Flashbang Defender");
        btnEl.setAttribute("aria-haspopup", "dialog");
        btnEl.setAttribute("aria-expanded", "false");
        btnEl.style.cssText = `
            position: relative;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 40px;
            height: 40px;
            border-radius: 20px;
            border: none;
            background-color: var(--yt-spec-badge-chip-background, rgba(255, 255, 255, 0.1));
            color: var(--yt-spec-text-primary, currentColor);
            cursor: pointer;
            padding: 0;
            margin: 0;
            box-sizing: border-box;
            transition: background-color 0.2s;
        `;

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
        dotEl.style.cssText = `
            position: absolute;
            top: 6px;
            right: 6px;
            width: 5px;
            height: 5px;
            border-radius: 50%;
            background-color: #00e676;
            box-shadow: 0 0 3px rgba(0, 230, 118, 0.7);
            pointer-events: none;
        `;
        btnEl.appendChild(dotEl);

        tooltipEl = document.createElement("div");
        tooltipEl.id = "yt-flashbang-defender-tooltip";
        tooltipEl.setAttribute("role", "tooltip");
        tooltipEl.style.cssText = `
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
        `;

        wrapperEl.append(btnEl, tooltipEl);

        wrapperEl.addEventListener("mouseenter", () => {
            if (!isPopupOpen) {
                tooltipEl.style.visibility = "visible";
                tooltipEl.style.opacity = "1";
            }
            btnEl.style.backgroundColor = "var(--yt-spec-button-chip-background-hover, rgba(255, 255, 255, 0.2))";
        });
        wrapperEl.addEventListener("mouseleave", () => {
            tooltipEl.style.opacity = "0";
            tooltipEl.style.visibility = "hidden";
            btnEl.style.backgroundColor = "var(--yt-spec-badge-chip-background, rgba(255, 255, 255, 0.1))";
        });

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

        updateButtonAppearance();
        segmented.after(wrapperEl);
        return true;
    }

    function ensureMountedWithRetry(attemptsLeft, delayMs) {
        clearTimeout(mountRetryTimer);
        mountRetryTimer = null;

        bindVideo();
        const onWatch = isWatchPage();
        const buttonReady = !onWatch || insertButton();
        const videoReady = Boolean(activeVideo);

        if (!onWatch && !isShortsPage() && !videoReady) {
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
        closePopup(false);
        if (!isWatchPage()) {
            disconnectActionBarObserver();
        }
        webglFailed = false;
        needsStateReset = true;
        lastFrameTime = 0;
        lastPresentedFrames = -1;
        lastVideoTime = -1;

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
        if (isWatchPage() && (!wrapperEl || !wrapperEl.isConnected)) {
            ensureMountedWithRetry(8, 200);
        }
        if (isEnabled && currentMode === "auto" && activeVideo && !webglFailed && !isContextLost) {
            layoutDirty = true;
            if (activeVideo.paused && hasRenderedFrame) {
                syncCanvasLayout();
            } else {
                scheduleNextFrame(activeVideo);
            }
        }
    }

    function onFullscreenChange() {
        markLayoutDirty();
        clearTimeout(fsTimer1);
        clearTimeout(fsTimer2);
        fsTimer1 = setTimeout(() => { fsTimer1 = null; markLayoutDirty(); }, 60);
        fsTimer2 = setTimeout(() => { fsTimer2 = null; markLayoutDirty(); }, 220);
    }

    function stopAll() {
        unbindVideo();
        destroyWebGLCanvas();
        closePopup(false);

        if (popupEl) {
            try { popupEl.remove(); } catch {}
            popupEl = null;
        }
        powerPillEl = optAutoEl = optManualEl = sliderContEl = sliderInputEl = sliderValEl = null;

        if (wrapperEl) {
            try { wrapperEl.remove(); } catch {}
            wrapperEl = null;
        }
        btnEl = dotEl = tooltipEl = null;

        document.getElementById("yt-flashbang-defender-wrapper")?.remove();
        document.getElementById("yt-fbd-webgl-canvas")?.remove();

        disconnectActionBarObserver();

        clearTimeout(navTimer);
        clearTimeout(mountRetryTimer);
        clearTimeout(fsTimer1);
        clearTimeout(fsTimer2);
        navTimer = mountRetryTimer = fsTimer1 = fsTimer2 = null;

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

    ensureMountedWithRetry(16, 150);
})();