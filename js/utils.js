import { state } from './state.js';

// --- SHARED UI ICONS (SVG) ---
export const SVG_PLAY = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5v14l11-7z"></path></svg>';
export const SVG_PAUSE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>';
export const SVG_STEP_BACK = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="11 17 6 12 11 7"></polyline><polyline points="18 17 13 12 18 7"></polyline></svg>';
export const SVG_STEP_FORWARD = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 17 18 12 13 7"></polyline><polyline points="6 17 11 12 6 7"></polyline></svg>';

// Neon Styles (Used in newer editors)
export const SVG_PLAY_MODERN = '<svg viewBox="0 0 24 24" width="16" height="16" fill="var(--accent)"><path d="M7 4.5l13 7.5-13 7.5V4.5z"/></svg>';
export const SVG_PAUSE_MODERN = '<svg viewBox="0 0 24 24" width="16" height="16" fill="var(--accent)"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
export const SVG_STEP_FWD_MODERN = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 17 18 12 13 7"></polyline><polyline points="6 17 11 12 6 7"></polyline></svg>';
export const SVG_STEP_BACK_MODERN = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="11 17 6 12 11 7"></polyline><polyline points="18 17 13 12 18 7"></polyline></svg>';
// Skip/Skip versions (often used in main preview)
export const SVG_SKIP_BACK = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="19 20 9 12 19 4 19 20"></polygon><line x1="5" y1="19" x2="5" y2="5"></line></svg>';
export const SVG_SKIP_FWD = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 4 15 12 5 20 5 4"></polygon><line x1="19" y1="5" x2="19" y2="19"></line></svg>';

export function bresenham(x0, y0, x1, y1) {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = (x0 < x1) ? 1 : -1;
    const sy = (y0 < y1) ? 1 : -1;
    let err = dx - dy;
    const points = [];

    while (true) {
        points.push({ x: x0, y: y0 });
        if ((x0 === x1) && (y0 === y1)) break;
        const e2 = 2 * err;
        if (e2 > -dy) { err -= dy; x0 += sx; }
        if (e2 < dx) { err += dx; y0 += sy; }
    }
    return points;
}

/**
 * Finds the nearest palette index for a given RGB color.
 * @param {number} r 
 * @param {number} g 
 * @param {number} b 
 * @param {Array} palette - Array of {r,g,b} or null
 * @returns {number} The index in the palette (0-255)
 */
export function findNearestPaletteIndex(r, g, b, palette) {
    let minD = Infinity;
    let bestIdx = 0;

    const skipIdx = state.isAlphaImageMode ? 127 : 0;

    for (let i = 0; i < 256; i++) {
        if (i === skipIdx) continue;
        const c = palette[i];
        if (!c) continue;

        const d = (c.r - r) ** 2 + (c.g - g) ** 2 + (c.b - b) ** 2;
        if (d === 0) return i;
        if (d < minD) {
            minD = d;
            bestIdx = i;
        }
    }
    return bestIdx;
}

/**
 * Finds the nearest palette index within a specific range.
 */
export function findNearestPaletteIndexInRange(r, g, b, palette, start, end) {
    let minD = Infinity;
    let bestIdx = start;
    for (let i = start; i <= end; i++) {
        const c = palette[i];
        if (!c) continue;
        const d = (c.r - r) ** 2 + (c.g - g) ** 2 + (c.b - b) ** 2;
        if (d === 0) return i;
        if (d < minD) {
            minD = d;
            bestIdx = i;
        }
    }
    return bestIdx;
}

export function setupAutoRepeat(btn, action, initialDelay = 500) {
    let timer = null;
    let currentDelay = initialDelay;

    const repeat = (e) => {
        action(e);
        // Aggressive acceleration: 50% reduction per repetition step
        currentDelay = Math.max(150, currentDelay * 0.5);
        timer = setTimeout(() => repeat(e), currentDelay);
    };

    const start = (e) => {
        if (e.button !== 0) return; // Only left click
        stop();
        currentDelay = initialDelay;
        action(e); // First click
        timer = setTimeout(() => repeat(e), currentDelay);
    };

    const stop = () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    };

    btn.addEventListener('mousedown', start);
    window.addEventListener('mouseup', stop);
    btn.addEventListener('mouseleave', stop);
}

/**
 * Unified frame compositing engine.
 * Computes a flat pixel array (Uint16 indexes) from a frame's layer tree,
 * respecting all masking and visibility rules.
 * 
 * @param {Object} frame - The frame object containing .layers, .width, .height
 * @param {Object} options - { 
 *    floatingSelection: Object, // Optional selection to overlay
 *    ctx: CanvasRenderingContext2D, // Optional: if provided, renders mapped pixels to it
 *    zoom: Number, // Used if ctx is provided
 *    palette: Array, // Required if ctx is provided
 *    remapBase: Object, // {r,g,b} for faction remapping (indices 16-31)
 *    transparentIdx: Number // The color index to treat as air (usually 0xFFFF)
 * }
 * @returns {Uint8Array} The final composited index array.
 */
export function compositeFrame(tile, options = {}) {
    const {
        transparentIdx = 0,
        backgroundIdx = 0,
        floatingSelection = null,
        ctx = null,
        palette = state.palette,
        remapBase = null,
        showIndex0 = true,
        alphaBuffer = null,
        substitutionMap = null,
        affectedIndices = null,
        visualData = null,
        extraAlpha = 255
    } = options;
    const w = tile.width;
    const h = tile.height;
    const res = new Uint8Array(w * h).fill(backgroundIdx);

    // 1. Draw Main Tile Data
    const actualTransparent = state.isAlphaImageMode ? 127 : 0;
    if (tile.data) {
        const dW = (tile.tileHeader) ? state.cx : w;
        const dH = (tile.tileHeader) ? state.cy : h;
        const dX = tile.diamondX || 0;
        const dY = tile.diamondY || 0;

        for (let y = 0; y < dH; y++) {
            const rowSrc = y * dW;
            const targetY = dY + y;
            if (targetY < 0 || targetY >= h) continue;
            const rowDest = targetY * w;

            for (let x = 0; x < dW; x++) {
                const idx = tile.data[rowSrc + x];
                if (idx === transparentIdx && !showIndex0) continue;
                
                const targetX = dX + x;
                if (targetX < 0 || targetX >= w) continue;
                
                const i = rowDest + targetX;
                res[i] = idx;
                if (alphaBuffer) alphaBuffer[i] = 255;
                
                if (visualData && palette) {
                    let finalIdx = idx;
                    if (substitutionMap && substitutionMap.has(idx)) finalIdx = substitutionMap.get(idx);
                    const col = palette[finalIdx] || { r: 0, g: 0, b: 0 };
                    const pi = i * 4;
                    visualData[pi] = col.r; visualData[pi+1] = col.g; visualData[pi+2] = col.b; visualData[pi+3] = 255;
                }
            }
        }
    }

    // 2. Draw Extra Image Data (Overflow)
    if (tile.extraImageData && tile.tileHeader && tile.tileHeader.has_extra_data) {
        const eth = tile.tileHeader;
        const ex = tile.extraX || 0;
        const ey = tile.extraY || 0;
        const ew = tile._extraImg_cx || eth.cx_extra;
        const eh = tile._extraImg_cy || eth.cy_extra;

        for (let y = 0; y < eh; y++) {
            const targetY = ey + y;
            if (targetY < 0 || targetY >= h) continue;
            const rowSrc = y * ew;
            const rowDest = targetY * w;

            for (let x = 0; x < ew; x++) {
                const targetX = ex + x;
                if (targetX < 0 || targetX >= w) continue;

                const idx = tile.extraImageData[rowSrc + x];
                if (idx === 0) continue; // 0 is always transparent in extra data

                const i = rowDest + targetX;
                res[i] = idx;
                if (alphaBuffer) alphaBuffer[i] = extraAlpha;
                
                if (visualData && palette) {
                    const col = palette[idx] || { r: 0, g: 0, b: 0 };
                    const pi = i * 4;
                    visualData[pi] = col.r; visualData[pi+1] = col.g; visualData[pi+2] = col.b; visualData[pi+3] = extraAlpha;
                }
            }
        }
    }

    // 3. Draw Floating Selection
    if (floatingSelection && floatingSelection.data) {
        const fs = floatingSelection;
        const fsW = fs.w || fs.width;
        const fsH = fs.h || fs.height;
        for (let fy = 0; fy < fsH; fy++) {
            const fySrc = fy * fsW;
            const ty = fs.y + fy;
            if (ty < 0 || ty >= h) continue;
            const rowDest = ty * w;
            for (let fx = 0; fx < fsW; fx++) {
                const tx = fs.x + fx;
                if (tx >= 0 && tx < w) {
                    const idx = fs.data[fySrc + fx];
                    if (idx === transparentIdx && !showIndex0) continue;

                    if (idx !== transparentIdx) {
                        const k = rowDest + tx;
                        res[k] = idx;
                        if (alphaBuffer) alphaBuffer[k] = 255;
                        
                        if (visualData && palette) {
                            let finalIdx = idx;
                            const col = palette[finalIdx] || { r: 0, g: 0, b: 0 };
                            const off = k * 4;
                            visualData[off] = col.r; visualData[off+1] = col.g; visualData[off+2] = col.b; visualData[off+3] = 255;
                        }
                    }
                }
            }
        }
    }

    // Default fill if not already set (for background pixels)
    if (alphaBuffer && options.fillAlphaMissing !== false) {
        // We only want to fill pixels that haven't been touched? 
        // Actually res is initialized with backgroundIdx.
    }

    // If a context is provided, render directly to it (simple blit)
    if (ctx && palette) {
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = w;
        tempCanvas.height = h;
        const tCtx = tempCanvas.getContext('2d');
        const imgData = tCtx.createImageData(w, h);
        const px = imgData.data;

        for (let i = 0; i < res.length; i++) {
            const idx = res[i];
            if (idx === transparentIdx && !showIndex0) continue;

            const col = palette[idx] || { r: 0, g: 0, b: 0 };
            const pi = i * 4;
            px[pi] = col.r; px[pi+1] = col.g; px[pi+2] = col.b; px[pi+3] = 255;
        }
        tCtx.putImageData(imgData, 0, 0);
        ctx.drawImage(tempCanvas, 0, 0);
    }

    return res;
}

