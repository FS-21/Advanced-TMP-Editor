import { state, generateId, TRANSPARENT_COLOR } from './state.js';
import { PcxLoader } from './pcx_loader.js';
import { elements, getLandTypeName, LAND_TYPE_NAMES, getRampTypeName, RAMP_TYPE_NAMES } from './constants.js';
import { RAMP_IMAGES } from './ramp_types.js';
import { pushHistory } from './history.js';
import { bresenham, findNearestPaletteIndex, setupAutoRepeat } from './utils.js';
import { updateUIState } from './main.js';
import { TmpTsFile } from './tmp_format.js';
import { t } from './translations.js';

let _worldCanvas = null;
let _worldBounds = { minX: 0, minY: 0, width: 0, height: 0 };

/* Animation for Marching Ants */
export function startAnts() {
    if (state.antsTimer) return; // Already running

    function animate() {
        if (!state.selection && !state.oldSelection) {
            stopAnts();
            return;
        }
        state.selectionDashOffset -= 0.3; // Slower animation speed for selection border
        if (state.selectionDashOffset < 0) state.selectionDashOffset = 8;

        // Don't render overlay if we're actively selecting (drawing pending selection)
        // The onmousemove handler will take care of rendering
        if (!state.isSelecting) {
            renderOverlay();
        }
        state.antsTimer = requestAnimationFrame(animate);
    }
    state.antsTimer = requestAnimationFrame(animate);
}

export function stopAnts() {
    if (state.antsTimer) {
        cancelAnimationFrame(state.antsTimer);
        state.antsTimer = null;
    }
}




export function updateCanvasSize() {
    // If we have world bounds, resize canvas to fit the whole TMP
    let cw = state.canvasW;
    let ch = state.canvasH;

    const w = cw * state.zoom;
    const h = ch * state.zoom;

    if (elements.mainCanvas) {
        // Safety cap to avoid Out of Memory (OOM) / disappearing canvas in browser
        const MAX_CANVAS = 24000;
        if (cw > MAX_CANVAS || ch > MAX_CANVAS) {
            console.warn(`[Canvas] Clamping excessively large world (${cw}x${ch}) to keep browser stable.`);
            cw = Math.min(cw, MAX_CANVAS);
            ch = Math.min(ch, MAX_CANVAS);
        }
        elements.mainCanvas.width = cw;
        elements.mainCanvas.height = ch;
    }

    if (elements.overlayCanvas) {
        elements.overlayCanvas.width = w;
        elements.overlayCanvas.height = h;
    }

    [elements.mainCanvas, elements.overlayCanvas].forEach(c => {
        if (!c) return;
        c.style.width = w + "px";
        c.style.height = h + "px";
        c.style.imageRendering = 'pixelated'; // Ensure sharp 1:1 or integer scaling
        const ctx = c.getContext('2d');
        if (ctx) ctx.imageSmoothingEnabled = false;
    });

    if (elements.canvasWrapper) {
        if (!state.tmpData || !state.worldBounds) {
            elements.canvasWrapper.style.display = 'none';
        } else {
            elements.canvasWrapper.style.display = 'block';
            
            if (state.showGameGrid) {
                const sc = elements.canvasScrollArea;
                if (sc) sc.style.padding = '0'; // Remove padding for background coverage
                
                const viewW = sc ? sc.clientWidth : 800;
                const viewH = sc ? sc.clientHeight : 600;
                
                // Canvas fills visible area, but also expands if image is bigger
                cw = Math.max(state.worldBounds.width, viewW / state.zoom);
                ch = Math.max(state.worldBounds.height, viewH / state.zoom);

                // Center the TMP inside this area
                const offsetX = (cw - state.worldBounds.width) / 2;
                const offsetY = (ch - state.worldBounds.height) / 2;

                state.viewBounds = {
                    minX: state.worldBounds.minX - offsetX,
                    minY: state.worldBounds.minY - offsetY,
                    width: cw,
                    height: ch
                };
            } else {
                const sc = elements.canvasScrollArea;
                if (sc) sc.style.padding = '20px'; // Restore editor breathing room
                
                state.viewBounds = { ...state.worldBounds };
                cw = state.worldBounds.width;
                ch = state.worldBounds.height;
            }

            const w_scaled = Math.ceil(cw * state.zoom);
            const h_scaled = Math.ceil(ch * state.zoom);

            // Apply to canvas
            elements.mainCanvas.width = cw;
            elements.mainCanvas.height = ch;
            if (elements.overlayCanvas) {
                elements.overlayCanvas.width = w_scaled;
                elements.overlayCanvas.height = h_scaled;
            }
            
            elements.canvasWrapper.style.width = w_scaled + "px";
            elements.canvasWrapper.style.height = h_scaled + "px";

            [elements.mainCanvas, elements.overlayCanvas].forEach(c => {
                if (!c) return;
                c.style.width = w_scaled + "px";
                c.style.height = h_scaled + "px";
                const ctx = c.getContext('2d');
                if (ctx) ctx.imageSmoothingEnabled = false;
            });
        }
    }

    // --- Grid Limit Monitoring ---
    if (state.tmpData && state.tmpData.header) {
        const cx = state.tmpData.header.cblocks_x;
        const cy = state.tmpData.header.cblocks_y;
        const total = cx * cy;
        const notif = elements.limitNotification;
        const msg = elements.limitNotificationMsg;

        if (notif && msg) {
            if (total > 256) {
                notif.className = 'notification-bar active error';
                notif.style.background = 'linear-gradient(to right, #4a0505, #8a0000)';
                notif.style.borderBottomColor = '#ff5555';
                msg.innerText = t('msg_limit_red');
            } else if (total > 121) {
                notif.className = 'notification-bar active warning';
                notif.style.background = 'linear-gradient(to right, #4a3e05, #8a7a00)';
                notif.style.borderBottomColor = '#ffd700';
                msg.innerText = t('msg_limit_yellow');
            } else {
                notif.classList.remove('active');
            }
        }
    } else if (elements.limitNotification) {
        elements.limitNotification.classList.remove('active');
    }

    if (elements.statusBar) {
        elements.statusBar.style.display = state.tmpData ? 'flex' : 'none';
    }

    updatePixelGrid();
}

/**
 * Shared helper to render a layer thumbnail (base + floating selection).
 */
const _layerThumbCache = new Map();

export function renderTileThumbnail(tile, ctx, w, h, forceFS = false, skipBG = false, subType = null) {
    // Optimization: Cache thumbnails to avoid expensive pixel loops
    // Added 'v2_pixel_perfect' string to force a full cache clear from older distorted versions
    // Added 'v8' and cx/cy to force cache clear when project dimensions change
    const layerKey = `${tile.id}_${tile._v || 0}_v8_${state.cx}x${state.cy}_nomask_z_${state.paletteVersion}_${state.showBackground ? 'bg' : 'nobg'}_${forceFS ? 'fs' : 'nofs'}_${skipBG ? 'skip' : 'noskip'}_${subType || 'all'}_${w}x${h}`;
    const cachedEntry = _layerThumbCache.get(layerKey);

    if (cachedEntry) {
        ctx.drawImage(cachedEntry, 0, 0);
        return;
    }

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = w;
    tempCanvas.height = h;
    const tCtx = tempCanvas.getContext('2d');

    // Original helper implementation below (re-rendering to tempCanvas)
    _renderTileThumbnailImmediate(tile, tCtx, w, h, forceFS, skipBG, subType);

    // Save to cache
    _layerThumbCache.set(layerKey, tempCanvas);

    // Output to real ctx
    ctx.drawImage(tempCanvas, 0, 0);
}

function _renderTileThumbnailImmediate(tile, ctx, w, h, forceFS = false, skipBG = false, subType = null) {
    const isDepth = subType && subType.includes('Z');
    const palLUT = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        if (isDepth) {
            if (i < 32) {
                const gray = Math.round((i * 255) / 31);
                palLUT[i] = (255 << 24) | (gray << 16) | (gray << 8) | gray;
            } else if (i === 255) {
                // Z=255 → Transparency/No-data (Black in preview)
                palLUT[i] = (255 << 24) | (0 << 16) | (0 << 8) | 0;
            } else {
                // Z=32-254 → alert RED (invalid Z range)
                palLUT[i] = (255 << 24) | (0 << 16) | (0 << 8) | 255;
            }
        } else {
            const c = state.palette[i] || { r: 0, g: 0, b: 0 };
            palLUT[i] = (255 << 24) | (c.b << 16) | (c.g << 8) | c.r;
        }
    }

    const imgData = ctx.createImageData(w, h);
    const d32 = new Uint32Array(imgData.data.buffer);

    if (isDepth) {
        if (!skipBG) {
            // Z-Data thumbnails use BLACK background (XCC/Original Style)
            // Z=255 (void) pixels are skipped below, so background shows through as black.
            d32.fill((255 << 24)); // opaque black
        }
    } else if (state.showBackground && !skipBG) {
        const bg = state.palette[0] || { r: 0, g: 0, b: 0 };
        const bgColor = (255 << 24) | (bg.b << 16) | (bg.g << 8) | bg.r;
        d32.fill(bgColor);
    } else if (!skipBG) {
        // Checkerboard
        const bgDark = (255 << 24) | (102 << 16) | (102 << 8) | 102;
        const bgLight = (255 << 24) | (153 << 16) | (153 << 8) | 153;
        for (let i = 0; i < d32.length; i++) {
            const x = i % w;
            const y = Math.floor(i / w);
            d32[i] = (((x >> 2) + (y >> 2)) % 2 === 0) ? bgDark : bgLight;
        }
    } else if (skipBG && !state.showBackground) {
        // Just transparent (cleared by caller)
    } else if (skipBG && state.showBackground) {
        const bg = state.palette[0] || { r: 0, g: 0, b: 0 };
        const bgColor = (255 << 24) | (bg.b << 16) | (bg.g << 8) | bg.r;
        d32.fill(bgColor);
    }

    if (tile) {
        let dataSource = null;
        let srcW = 0;
        let srcH = 0;
        let startX = 0;
        let startY = 0;
        let viewW = 0;
        let viewH = 0;

        if (subType === 'base') {
            dataSource = tile.data;
            srcW = state.cx;
            srcH = state.cy;
            viewW = srcW;
            viewH = srcH;
        } else if (subType === 'baseZ') {
            dataSource = tile.zData;
            if (!dataSource) return;
            srcW = state.cx;
            srcH = state.cy;
            viewW = srcW;
            viewH = srcH;
        } else if (subType === 'extraZ') {
            dataSource = tile.extraZData;
            if (!dataSource) return;
            // Use metadata dimensions if valid, otherwise fallback to header
            srcW = (tile._extraZ_cx && dataSource.length >= tile._extraZ_cx * tile._extraZ_cy) ? tile._extraZ_cx : tile.tileHeader.cx_extra;
            srcH = (tile._extraZ_cy && dataSource.length >= tile._extraZ_cx * tile._extraZ_cy) ? tile._extraZ_cy : tile.tileHeader.cy_extra;
            viewW = srcW;
            viewH = srcH;
        } else if (subType === 'extra') {
            dataSource = tile.extraImageData;
            // Don't return early: still paint the background (palette color 0) even if no image exists
            if (dataSource) {
                // Use metadata dimensions if valid, otherwise fallback to header
                srcW = (tile._extraImg_cx && dataSource.length >= tile._extraImg_cx * tile._extraImg_cy) ? tile._extraImg_cx : tile.tileHeader.cx_extra;
                srcH = (tile._extraImg_cy && dataSource.length >= tile._extraImg_cx * tile._extraImg_cy) ? tile._extraImg_cy : tile.tileHeader.cy_extra;
                viewW = srcW;
                viewH = srcH;
            } else {
                // No image yet – background was already filled above; nothing to draw
                ctx.putImageData(imgData, startX, startY);
                return;
            }
        } else {
            // "All" or unknown: use full composite (fallback)
            const cached = _getCachedComposite(tile, { palette: state.palette });
            dataSource = cached.pixels;
            srcW = tile.width;
            srcH = tile.height;
            viewW = srcW;
            viewH = srcH;
        }

        const offsetX = Math.floor((w - viewW) / 2);
        const offsetY = Math.floor((h - viewH) / 2);

        // Direct 1:1 pixel mapping (No scaling artifacts)
        for (let py = 0; py < viewH; py++) {
            const outY = py + offsetY;
            if (outY < 0 || outY >= h) continue;
            
            const srcY = py + startY;
            if (srcY < 0 || srcY >= srcH) continue;
            
            const rowBase = srcY * srcW;
            const outRowBase = outY * w;

            for (let px = 0; px < viewW; px++) {
                const outX = px + offsetX;
                if (outX < 0 || outX >= w) continue;
                
                const srcX = px + startX;
                if (srcX < 0 || srcX >= srcW) continue;

                const idx = dataSource[rowBase + srcX];
                
                if (isDepth) {
                    const isBaseZ = subType === 'baseZ';
                    const isExtraZ = subType === 'extraZ';
                    
                    if (isBaseZ) {
                        const isInside = TmpTsFile.isInsideWestwoodDiamond(srcX, srcY, srcW, srcH);
                        if (!isInside || idx === 255 || idx === 0) continue;
                        d32[outRowBase + outX] = palLUT[idx & 0xFF];
                    } else if (isExtraZ) {
                        if (idx < 32) {
                            d32[outRowBase + outX] = palLUT[idx & 0xFF];
                        } else if (idx === 255 || idx === 0) {
                            // Hit test against BASE DIAMOND of the same tile
                            const bw = state.cx; 
                            const bh = state.cy;
                            const dx = (tile.tileHeader.x_extra || 0) - tile.tileHeader.x;
                            const dy = (tile.tileHeader.y_extra || 0) - tile.tileHeader.y;
                            
                            // Map local extra coord back to base diamond coord
                            const bx = srcX + dx;
                            const by = srcY + dy;
                            
                            const isOverDiamond = TmpTsFile.isInsideWestwoodDiamond(bx, by, bw, bh);
                            if (isOverDiamond) {
                                // RED alert for overlap with base cell
                                d32[outRowBase + outX] = (255 << 24) | (0 << 16) | (0 << 8) | 255;
                            } else {
                                // Transparent black for outside
                                d32[outRowBase + outX] = (255 << 24) | (0 << 16) | (0 << 8) | 0;
                            }
                        }
                    }
                } else {
                    // IMAGE MERGE: If skipBG is true OR showBackground is false, treat index 255/0 as transparent
                    const isImgTransparent = (idx === 255) || (skipBG && idx === 0) || (!state.showBackground && idx === 0);
                    if (!isImgTransparent) {
                        d32[outRowBase + outX] = palLUT[idx & 0xFF];
                    }
                }
            }
        }
    }

    ctx.putImageData(imgData, 0, 0);
}


export function updatePixelGrid() {
    if (!elements.pixelGridOverlay) return;

    // Show grid if toggled ON and zoom >= 400%
    const shouldShow = state.showGrid && state.zoom >= 4;
    elements.pixelGridOverlay.style.display = shouldShow ? 'block' : 'none';

    if (shouldShow) {
        elements.pixelGridOverlay.classList.toggle('grid-dark', state.gridColor === 'dark');
        elements.pixelGridOverlay.style.backgroundSize = `${state.zoom}px ${state.zoom}px`;
    }

    if (elements.btnToggleGrid) {
        elements.btnToggleGrid.classList.toggle('grid-active', state.showGrid);
    }
}

export function handlePaletteSelect(e) {
    const cell = e.target.closest('.pal-cell');
    if (!cell) return;

    const idx = parseInt(cell.dataset.idx, 10);

    // 1. Single-purpose modal pickers (Square Fill) - keep early return as before
    if (state.isPickingSquareFill) {
        const color = state.palette[idx];
        if (color) {
            const hex = '#' +
                color.r.toString(16).padStart(2, '0') +
                color.g.toString(16).padStart(2, '0') +
                color.b.toString(16).padStart(2, '0');

            state.toolSettings.squareFillColor = hex;
            if (elements.inpSquareFillColor) elements.inpSquareFillColor.value = hex;

            const info = document.getElementById('squareFillInfo');
            if (info) {
                info.innerText = `${state.translations.tt_idx}: ${idx} (${color.r},${color.g},${color.b})`;
            }

            state.isPickingSquareFill = false;
            document.body.classList.remove('picking-mode');
            const overlay = document.getElementById('modalOverlay');
            if (overlay) overlay.classList.remove('active');
            const help = document.getElementById('pickerHelpText');
            if (help) help.style.display = 'none';
        }
        return;
    }

    // 2. Normal Palette Selection (Multi-select, etc.)
    if (e.shiftKey && state.lastPaletteIdx !== -1) {
        const [s, en] = [Math.min(state.lastPaletteIdx, idx), Math.max(state.lastPaletteIdx, idx)];
        state.paletteSelection.clear();
        for (let k = s; k <= en; k++) state.paletteSelection.add(k);
    } else if (e.ctrlKey) {
        if (state.paletteSelection.has(idx)) {
            state.paletteSelection.delete(idx);
        } else {
            state.paletteSelection.add(idx);
        }
        state.lastPaletteIdx = idx;
    } else {
        state.paletteSelection.clear();
        state.paletteSelection.add(idx);
        state.lastPaletteIdx = idx;
    }

    // Standard Color Update
    setColor(idx);
}

export function setColor(idx) {
    state.primaryColorIdx = idx;
    renderPalette();

    const color = state.palette[idx];
    const p = elements.primaryColorPreview;
    if (p) {
        if (color) p.style.backgroundColor = `rgb(${color.r},${color.g},${color.b})`;
        else p.style.backgroundColor = '#000';
    }

    const txt = document.getElementById('primaryColorIdx');
    if (txt) {
        if (color) txt.innerText = `${state.translations.tt_idx}: ${idx} (${color.r},${color.g},${color.b})`;
        else txt.innerText = `${state.translations.tt_idx}: ${idx} (${state.translations.tt_empty})`;
    }


    if (typeof updateUIState === 'function') updateUIState();
}



export function zoomToSelection() {
    if (!state.selection) return;

    const sel = state.selection;
    const scrollArea = document.getElementById('canvasScrollArea');
    if (!scrollArea) return;

    // Viewport dimensions (scrollArea minus its double padding of 20px)
    const vw = scrollArea.clientWidth - 40;
    const vh = scrollArea.clientHeight - 40;

    const zoomW = (vw / sel.w) * 100;
    const zoomH = (vh / sel.h) * 100;

    let zoom = Math.min(zoomW, zoomH);
    zoom = Math.floor(zoom / 10) * 10; // Round to nearest 10
    zoom = Math.max(100, Math.min(5000, zoom));

    if (elements.inpZoom) elements.inpZoom.value = zoom;
    if (elements.inpZoom) elements.inpZoom.dispatchEvent(new Event('input'));

    // Center scroll area on selection
    setTimeout(() => {
        const z = zoom / 100;
        // Selection center relative to canvas (0,0) scaled by zoom
        const selCenterX = (sel.x + sel.w / 2) * z;
        const selCenterY = (sel.y + sel.h / 2) * z;

        // Scroll area center: 
        // We want selCenterX to be at scrollArea.scrollLeft + scrollArea.clientWidth / 2
        // We also have to account for the 20px padding if we want absolute precision, 
        // but scrollLeft handles the child positioning relative to the padded box usually.

        const scrollX = selCenterX - scrollArea.clientWidth / 2 + 20;
        const scrollY = selCenterY - scrollArea.clientHeight / 2 + 20;

        scrollArea.scrollLeft = scrollX;
        scrollArea.scrollTop = scrollY;
    }, 50);
}

export function recenterOnSelectedTiles() {
    if (state.tileSelection.size === 0) return;
    const scrollArea = document.getElementById('canvasScrollArea');
    if (!scrollArea) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    state.tileSelection.forEach(idx => {
        const t = state.tiles[idx];
        if (t) {
            minX = Math.min(minX, t.itemMinX);
            minY = Math.min(minY, t.itemMinY);
            maxX = Math.max(maxX, t.itemMinX + t.width);
            maxY = Math.max(maxY, t.itemMinY + t.height);
        }
    });

    if (minX === Infinity) return;

    const z = (state.zoom || 100) / 100;
    const bounds = state.worldBounds || { minX: 0, minY: 0 };
    
    // Selection center in world relative to world (0,0)
    const centerX = (minX + maxX) / 2 - bounds.minX;
    const centerY = (minY + maxY) / 2 - bounds.minY;

    // Scale to current zoom
    const targetX = centerX * z;
    const targetY = centerY * z;

    scrollArea.scrollLeft = targetX - scrollArea.clientWidth / 2;
    scrollArea.scrollTop = targetY - scrollArea.clientHeight / 2;
}


export function renderCanvas() {
    const ctx = elements.ctx;
    if (!ctx) return;
    
    // Use the actual physical canvas resolution for rendering the image buffer.
    // This prevents size mismatches with putImageData when the viewport is larger than the world.
    const w = Math.round(ctx.canvas.width);
    const h = Math.round(ctx.canvas.height);

    // Safeguard: If bounds are missing but project exists, recompute them briefly.
    if (state.tmpData && !state.worldBounds) {
        recomputeWorldBoundsFromState();
    }

    // 1. Clear BG - relies entirely on imgData pre-fill below (putImageData overwrites fillRect).
    if (state.showBackground) {
        if (elements.canvasWrapper) elements.canvasWrapper.classList.remove('checkerboard-bg');
    } else {
        ctx.clearRect(0, 0, w, h);
        if (elements.canvasWrapper) elements.canvasWrapper.classList.add('checkerboard-bg');
    }

    if (!state.tmpData) return;

    const imgData = ctx.createImageData(w, h);
    const d = imgData.data;

    // Fill imgData with bg if requested — this is what actually ends up on screen via putImageData
    if (state.showBackground) {
        // If Z-Data view is active, background MUST be black (Z=0)
        const bg = (state.visualMode === 'zdata') ? { r: 0, g: 0, b: 0 } : (state.palette[0] || { r: 0, g: 0, b: 0 });
        const alpha = state.showBackground ? 255 : 0;
        for (let i = 0; i < d.length; i += 4) {
            d[i] = bg.r; d[i + 1] = bg.g; d[i + 2] = bg.b; d[i + 3] = alpha;
        }
    } else {
        // Transparent initially
        for (let i = 0; i < d.length; i += 4) d[i + 3] = 0;
    }

    // 2. Draw all Tiles
    const halfCy = state.cy / 2;
    const mult = halfCy;
    const viewBounds = state.viewBounds || state.worldBounds || { minX: 0, minY: 0 };
    const minX = viewBounds.minX;
    const minY = viewBounds.minY;

    const tilesToHighlight = Array.from(state.tileSelection);
    state.overlappingTiles.clear();
    // Always check EVERYTHING for overlap feedback in the list
    for (let i = 0; i < state.tiles.length; i++) {
        if (_isTileOverlapping(i)) state.overlappingTiles.add(i);
    }
    syncListOverlaps();

    // Coverage mask for Z-Data mode: tracks which pixels already have valid Z data (0-31).
    // RED pixels (Z 32-254) must not overwrite solid grey from other tiles below.
    const zValidMask = state.visualMode === 'zdata' ? new Uint8Array(w * h) : null;

    for (let i = 0; i < state.tiles.length; i++) {
        const tile = state.tiles[i];
        if (!tile || !tile.tileHeader) continue;

        const h_tile = tile.tileHeader;
        const elevation = state.flatCells ? 0 : h_tile.height * (state.cy / 2);

        if (state.visualMode === 'placeholders') {
            // --- PLACEHOLDERS VIEW MODE ---
            // Draw outlines only (White if selected, Red if not)
            const isSelected = state.tileSelection.has(i);
            const hlColor = isSelected ? '#ffffff' : '#00ff00';

            const lx = Math.round(tile.itemMinX - minX);
            const ly = Math.round(tile.itemMinY - minY);

            // Base Diamond
            const dX = Math.round(tile.diamondX);
            const dY = Math.round(tile.diamondY);
            _drawWestwoodDiamond(ctx, imgData, d, w, h, lx + dX, ly + dY, state.cx, state.cy, hlColor);

            // Extra Data Outline (Content-Aware)
            if (h_tile.has_extra_data) {
                const ex = Math.round(tile.extraX);
                const ey = Math.round(tile.extraY);
                const ew = Math.round(h_tile.cx_extra);
                const eh = Math.round(h_tile.cy_extra);

                // Priority: Use Z-Data for outline if it has any non-void content
                let dataToUse = null;
                let isZMapping = false;

                if (tile.extraZData) {
                    for (let j = 0; j < tile.extraZData.length; j++) {
                        const val = tile.extraZData[j];
                        if (val !== 0 && val !== 255) {
                            dataToUse = tile.extraZData;
                            isZMapping = true;
                            break;
                        }
                    }
                }

                // Fallback: Use Image Data if Z-Data is empty or missing
                if (!dataToUse && tile.extraData) {
                    dataToUse = tile.extraData;
                    isZMapping = false;
                }

                if (dataToUse) {
                    _drawContentOutline(imgData, d, w, h, lx + ex, ly + ey, ew, eh, dataToUse, isZMapping, hlColor);
                } else {
                    // ONLY draw the bounding rectangle if the extra data is truly empty 
                    // (no Z-Data and no Image pixels), to avoid visual noise.
                    _drawPixelRect(ctx, imgData, d, w, h, lx + ex, ly + ey, ew, eh, hlColor);
                }
            }
        } else if (state.visualMode === 'zdata') {
            // --- Z-DATA VIEW MODE (Matched to Export Algorithm) ---
            // 1. Draw Base Z at its original world position
            const zBuf = tile.zData;
            if (zBuf) {
                const bx = Math.round(h_tile.x - minX);
                const by = Math.round(h_tile.y - elevation - minY);
                const bw = state.cx; 
                const bh = state.cy;

                for (let ty = 0; ty < bh; ty++) {
                    const py = by + ty;
                    if (py < 0 || py >= h) continue;
                    const destRow = py * w;
                    const srcRow = ty * bw;
                    for (let tx = 0; tx < bw; tx++) {
                        const zVal = zBuf[srcRow + tx];
                        // FIXED MASK: Skip ALL pixels outside the diamond to avoid overlapping neighbors
                        if (!TmpTsFile.isInsideWestwoodDiamond(tx, ty, bw, bh)) continue;

                        const px = bx + tx;
                        if (px >= 0 && px < w) {
                            const target = (destRow + px) * 4;
                            if (zVal < 32) {
                                // Z=0-31 → greyscale ramp (0=black, 31=white)
                                const gray = Math.round((zVal * 255) / 31);
                                d[target] = gray; d[target+1] = gray; d[target+2] = gray; d[target+3] = 255;
                                if (zValidMask) zValidMask[destRow + px] = 1; // mark as valid
                            } else if (zVal === 255) {
                                // Z=255 → Transparency
                                d[target] = 0; d[target+1] = 0; d[target+2] = 0; d[target+3] = 255;
                            } else {
                                // Z=32-254 → RED alert
                                if (!zValidMask || !zValidMask[destRow + px]) {
                                    d[target] = 255; d[target+1] = 0; d[target+2] = 0; d[target+3] = 255;
                                }
                            }
                        }
                    }
                }
            }

            // 2. Draw Extra Z-Data if present at its world position
            if (h_tile.has_extra_data && tile.extraZData) {
                const zData = tile.extraZData;
                const ezW = tile._extraZ_cx || h_tile.cx_extra;
                const ezH = tile._extraZ_cy || h_tile.cy_extra;
                const ex = Math.round((h_tile.x_extra || 0) - minX);
                const ey = Math.round((h_tile.y_extra || 0) - elevation - minY);
                
                for (let ty = 0; ty < ezH; ty++) {
                    const py = ey + ty;
                    if (py < 0 || py >= h) continue;
                    const destRow = py * w;
                    const srcRow = ty * ezW;
                    for (let tx = 0; tx < ezW; tx++) {
                        const zVal = zData[srcRow + tx];
                        // Z-Data from Extra objects: also respects its own rectangle (not diamond necessarily but we filter 0/255 if it's void)
                        if (zVal === 0 || zVal === 255) continue;

                        const px = ex + tx;
                        if (px >= 0 && px < w) {
                            const target = (destRow + px) * 4;
                            if (zVal < 32) {
                                const gray = Math.round((zVal * 255) / 31);
                                d[target] = gray; d[target+1] = gray; d[target+2] = gray; d[target+3] = 255;
                                if (zValidMask) zValidMask[destRow + px] = 1;
                            } else if (zVal === 255 || zVal === 0) {
                                // Extra Z Overlap Test
                                const bw = state.cx;
                                const bh = state.cy;
                                const bx = Math.round(h_tile.x - minX);
                                const by = Math.round(h_tile.y - elevation - minY);
                                
                                const lx = px - bx;
                                const ly = py - by;
                                
                                if (TmpTsFile.isInsideWestwoodDiamond(lx, ly, bw, bh)) {
                                    d[target] = 255; d[target+1] = 0; d[target+2] = 0; d[target+3] = 255;
                                } else {
                                    d[target] = 0; d[target+1] = 0; d[target+2] = 0; d[target+3] = 255;
                                }
                            } else {
                                if (!zValidMask || !zValidMask[destRow + px]) {
                                    d[target] = 255; d[target+1] = 0; d[target+2] = 0; d[target+3] = 255;
                                }
                            }
                        }
                    }
                }
            }
        } else {
            // --- NORMAL IMAGE VIEW MODE ---
            const lx = Math.round(tile.itemMinX - minX);
            const ly = Math.round(tile.itemMinY - minY);
            const tw = tile.width;
            const th_h = tile.height;

            const cached = _getCachedComposite(tile, { palette: state.palette });
            const pixels = cached.pixels;
            const alphaBuf = cached.alpha;

            for (let ty = 0; ty < th_h; ty++) {
                const py = ly + ty;
                if (py < 0 || py >= h) continue;

                const destRow = py * w;
                const srcRow = ty * tw;
                for (let tx = 0; tx < tw; tx++) {
                    const idx = pixels[srcRow + tx];
                    if (idx !== TRANSPARENT_COLOR) {
                        const px = lx + tx;
                        if (px >= 0 && px < w) {
                            const target = (destRow + px) * 4;
                            const col = state.palette[idx] || { r: 0, g: 0, b: 0 };
                            const alpha = alphaBuf ? alphaBuf[srcRow + tx] : 255;
                        if (alpha === 255) {
                                d[target] = col.r;
                                d[target + 1] = col.g;
                                d[target + 2] = col.b;
                                d[target + 3] = 255;
                            } else if (alpha > 0) {
                                const a = alpha / 255;
                                const ia = 1.0 - a;
                                d[target] = (col.r * a + d[target] * ia) | 0;
                                d[target + 1] = (col.g * a + d[target + 1] * ia) | 0;
                                d[target + 2] = (col.b * a + d[target + 2] * ia) | 0;
                                // Preserve background alpha if it was already solid
                                if (d[target + 3] < 255) {
                                    d[target + 3] = (alpha + d[target + 3] * ia) | 0;
                                }
                            }
                        }
                    }
                }
            }
        } // end else (image mode)
    }

    // 3. Pixel-art tile selection highlights (drawn at 1:1, CSS zoom handles scaling)
    tilesToHighlight.forEach(idx => {
        const tile = state.tiles[idx];
        if (!tile || !tile.tileHeader) return;

        const lx = Math.round(tile.itemMinX - minX);
        const ly = Math.round(tile.itemMinY - minY);

        const showBase = state.bondSelection || state.subSelection.has(`${idx}_base`);
        const showExtra = state.bondSelection || state.subSelection.has(`${idx}_extra`);

        const hlColor = '#ffffff';

        // 3a. Isometric Diamond (Westwood classic 2:1 exact mask tracer)
        if (showBase) {
            const dX = Math.round(tile.diamondX);
            const dY = Math.round(tile.diamondY);
            const cx = Math.round(state.cx);
            const cy = Math.round(state.cy);

            _drawWestwoodDiamond(ctx, imgData, d, w, h, lx + dX, ly + dY, cx, cy, hlColor);
        }

        // 3b. Extra Data Rect (1px pixel rect) - Skip in placeholders to avoid overlapping with silhouette
        if (state.visualMode !== 'placeholders' && tile.tileHeader.has_extra_data && showExtra) {
            const ex = Math.round(tile.extraX);
            const ey = Math.round(tile.extraY);
            const ew = Math.round(tile.tileHeader.cx_extra);
            const eh = Math.round(tile.tileHeader.cy_extra);

            const rx = lx + ex;
            const ry = ly + ey;
            _drawPixelRect(ctx, imgData, d, w, h, rx, ry, ew, eh, hlColor);
        }
    });

    ctx.putImageData(imgData, 0, 0);
    syncListOverlaps();

    // 4. Draw Game Grid LAST so it persists over everything
    if (state.showGameGrid) {
        _renderGameGrid(ctx, w, h);
    }
    updateActiveTilePreview();
    if (typeof updateMenuState === 'function') updateMenuState(state.tiles.length > 0);
}

// Exact Westwood 2:1 isometric diamond tracer (matching XCC)
function _drawWestwoodDiamond(ctx, imgData, d, w, h, bx, by, cx, cy, color, isGrid = false) {
    let r = 255, g = 255, b = 255, a = 255;
    if (color.startsWith('rgba')) {
        const m = color.match(/[\d.]+/g);
        if (m) { r = +m[0]; g = +m[1]; b = +m[2]; a = Math.round(+m[3] * 255); }
    } else if (color.startsWith('#')) {
        const hex = color.slice(1);
        if (hex.length === 6) {
            r = parseInt(hex.slice(0, 2), 16);
            g = parseInt(hex.slice(2, 4), 16);
            b = parseInt(hex.slice(4, 6), 16);
        } else if (hex.length === 3) {
            r = parseInt(hex[0] + hex[0], 16);
            g = parseInt(hex[1] + hex[1], 16);
            b = parseInt(hex[2] + hex[2], 16);
        }
    }
    
    function sp(x, y) {
        if (x >= 0 && x < w && y >= 0 && y < h) {
            const off = (y * w + x) * 4;
            
            // Non-additive check for Grid: if pixel already has the same R,G,B as our grid, 
            // skip blending to prevent bright 'ghost dots' where diamonds intersect.
            if (isGrid && d[off] === r && d[off+1] === g && d[off+2] === b) return;

            if (a === 255) {
                d[off] = r; d[off+1] = g; d[off+2] = b; d[off+3] = 255;
            } else {
                const aa = a / 255;
                d[off] = Math.round(d[off] * (1 - aa) + r * aa);
                d[off + 1] = Math.round(d[off + 1] * (1 - aa) + g * aa);
                d[off + 2] = Math.round(d[off + 2] * (1 - aa) + b * aa);
                d[off + 3] = 255;
            }
        }
    }

    const halfW = Math.floor(cx / 2);
    const halfH = Math.floor(cy / 2);

    for (let y = 0; y < cy; y++) {
        let ry;
        // XCC logic: first half goes from 0 to halfH-1, second half shrinks back.
        // It produces a single row of maximum width (cx) at y = halfH-1.
        if (y < halfH) {
            ry = y;
        } else {
            ry = cy - 1 - y - 1;
        }

        if (ry < 0) continue;

        // Westwood 2:1 isometric step logic matching XCC
        // x decreases by 2 each line in first half, cx_line increases by 4.
        const xOffset = halfW - (ry + 1) * 2;
        const cx_line = (ry+1) * 4;

        if (cx_line <= 0) continue;

        // Left edge (2 pixels)
        sp(bx + xOffset, by + y);
        sp(bx + xOffset + 1, by + y);

        // Right edge (2 pixels)
        sp(bx + xOffset + cx_line - 2, by + y);
        sp(bx + xOffset + cx_line - 1, by + y);
    }
}

function _renderGameGrid(ctx, w, h) {
    const viewBounds = state.viewBounds || state.worldBounds || { minX: 0, minY: 0 };
    const minX = viewBounds.minX;
    const minY = viewBounds.minY;
    
    const cx = state.cx;
    const cy = state.cy;
    const halfCx = cx / 2;
    const halfCy = cy / 2;

    // Find reference tile and get its EXACT screen position
    let refScreenX = -minX;
    let refScreenY = -minY;
    let refSlotGX = 0, refSlotGY = 0;
    if (state.tmpData && state.tiles) {
        const cblocks_x = state.tmpData.header.cblocks_x;
        for (let i = 0; i < state.tiles.length; i++) {
            const tile = state.tiles[i];
            if (!tile || !tile.tileHeader) continue;
            refSlotGX = i % cblocks_x;
            refSlotGY = Math.floor(i / cblocks_x);
            refScreenX = Math.round(tile.itemMinX - minX) + Math.round(tile.diamondX);
            refScreenY = Math.round(tile.itemMinY - minY) + Math.round(tile.diamondY);
            break;
        }
    }

    const gridColor = state.showBackground ? 'rgba(255, 255, 255, 0.4)' : 'rgba(0, 255, 170, 0.6)';

    // Use ImageData for pixel-perfect lines
    const imgData = ctx.getImageData(0, 0, w, h);
    const d = imgData.data;

    for (let gx = -64; gx <= 64; gx++) {
        for (let gy = -64; gy <= 64; gy++) {
            const dgx = gx - refSlotGX;
            const dgy = gy - refSlotGY;
            const bx = refScreenX + Math.round(halfCx * (dgx - dgy));
            const by = refScreenY + Math.round(halfCy * (dgx + dgy));
            
            if (bx + cx < 0 || bx > w || by + cy < 0 || by > h) continue;

            // Don't skip anymore - draw the grid everywhere to avoid 'ghost' gaps
            _drawWestwoodDiamond(ctx, imgData, d, w, h, bx, by, cx, cy, gridColor, true);
        }
    }
    
    ctx.putImageData(imgData, 0, 0);
}

// Bresenham line drawing directly into imgData for pixel-art selection
function _drawPixelLine(ctx, imgData, d, w, h, x0, y0, x1, y1, color) {
    // Parse color to RGB
    let r = 255, g = 255, b = 255, a = 255;
    if (color.startsWith('rgba')) {
        const m = color.match(/[\d.]+/g);
        if (m) { r = +m[0]; g = +m[1]; b = +m[2]; a = Math.round(+m[3] * 255); }
    } else if (color.startsWith('#')) {
        const hex = color.slice(1);
        if (hex.length === 6) {
            r = parseInt(hex.slice(0, 2), 16);
            g = parseInt(hex.slice(2, 4), 16);
            b = parseInt(hex.slice(4, 6), 16);
        } else if (hex.length === 3) {
            r = parseInt(hex[0] + hex[0], 16);
            g = parseInt(hex[1] + hex[1], 16);
            b = parseInt(hex[2] + hex[2], 16);
        }
    }

    let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    let dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;

    while (true) {
        if (x0 >= 0 && x0 < w && y0 >= 0 && y0 < h) {
            const off = (y0 * w + x0) * 4;
            if (a === 255) {
                d[off] = r; d[off + 1] = g; d[off + 2] = b; d[off + 3] = 255;
            } else {
                const aa = a / 255;
                d[off] = Math.round(d[off] * (1 - aa) + r * aa);
                d[off + 1] = Math.round(d[off + 1] * (1 - aa) + g * aa);
                d[off + 2] = Math.round(d[off + 2] * (1 - aa) + b * aa);
                d[off + 3] = 255;
            }
        }
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
    }
}

// Pixel-art rectangle border (1px) directly into imgData
function _drawPixelRect(ctx, imgData, d, w, h, rx, ry, rw, rh, color) {
    _drawPixelLine(ctx, imgData, d, w, h, rx, ry, rx + rw - 1, ry, color);           // top
    _drawPixelLine(ctx, imgData, d, w, h, rx + rw - 1, ry, rx + rw - 1, ry + rh - 1, color); // right
    _drawPixelLine(ctx, imgData, d, w, h, rx + rw - 1, ry + rh - 1, rx, ry + rh - 1, color); // bottom
    _drawPixelLine(ctx, imgData, d, w, h, rx, ry + rh - 1, rx, ry, color);           // left
}

/**
 * Traces the silhouette of content (Z-Data or Image) and draws its border pixels.
 */
function _drawContentOutline(imgData, d, w, h, bx, by, cw, ch, data, isZData, color) {
    if (!data) return;
    
    // Parse color to RGB for fast access
    let r = 255, g = 255, b = 255;
    if (color.startsWith('#')) {
        const hex = color.slice(1);
        if (hex.length === 6) {
            r = parseInt(hex.slice(0, 2), 16);
            g = parseInt(hex.slice(2, 4), 16);
            b = parseInt(hex.slice(4, 6), 16);
        }
    }
    
    const transp = (typeof TRANSPARENT_COLOR !== 'undefined') ? TRANSPARENT_COLOR : 255;

    for (let ty = 0; ty < ch; ty++) {
        for (let tx = 0; tx < cw; tx++) {
            const idx = ty * cw + tx;
            const val = data[idx];
            
            // Define solid content: 
            // In Z-Data: anything not 0 and not 255
            // In Image: anything not TRANSPARENT_COLOR
            const isSolid = isZData ? (val !== 0 && val !== 255) : (val !== transp);
            
            if (isSolid) {
                let isOutline = false;
                // Boundary check
                if (tx === 0 || tx === cw - 1 || ty === 0 || ty === ch - 1) {
                    isOutline = true;
                } else {
                    // Neighborhood check (4-connectivity)
                    const u = data[idx - cw];
                    const d1 = data[idx + cw];
                    const l = data[idx - 1];
                    const r1 = data[idx + 1];
                    
                    const uSolid = isZData ? (u !== 0 && u !== 255) : (u !== transp);
                    const dSolid = isZData ? (d1 !== 0 && d1 !== 255) : (d1 !== transp);
                    const lSolid = isZData ? (l !== 0 && l !== 255) : (l !== transp);
                    const rSolid = isZData ? (r1 !== 0 && r1 !== 255) : (r1 !== transp);
                    
                    if (!uSolid || !dSolid || !lSolid || !rSolid) isOutline = true;
                }
                
                if (isOutline) {
                    const px = bx + tx;
                    const py = by + ty;
                    if (px >= 0 && px < w && py >= 0 && py < h) {
                        const off = (py * w + px) * 4;
                        d[off] = r; d[off+1] = g; d[off+2] = b; d[off+3] = 255;
                    }
                }
            }
        }
    }
}

/**
 * Returns a Uint8Array matching the canvas dimensions containing the rasterized content of a tile.
 * Includes floating selection if active.
 */
export function getTileDataSnapshot(tile) {
    if (!tile) return null;
    const w = state.canvasW;
    const h = state.canvasH;
    const buffer = new Uint8Array(w * h).fill(TRANSPARENT_COLOR);
    const minX = state.worldBounds.minX;
    const minY = state.worldBounds.minY;

    // Relative to the Project top-left
    const lx = Math.round(tile.itemMinX - minX);
    const ly = Math.round(tile.itemMinY - minY);

    // 1. Diamond Data
    if (tile.data) {
        const dX = Math.round(lx + tile.diamondX);
        const dY = Math.round(ly + tile.diamondY);
        const dW = state.cx; const dH = state.cy;
        for (let y = 0; y < dH; y++) {
            const outY = dY + y;
            if (outY < 0 || outY >= h) continue;
            const srcRow = y * dW;
            const destRow = outY * w;
            for (let x = 0; x < dW; x++) {
                const outX = dX + x;
                if (outX >= 0 && outX < w) {
                    const idx = tile.data[srcRow + x];
                    if (idx !== TRANSPARENT_COLOR) buffer[destRow + outX] = idx;
                }
            }
        }
    }

    // 2. Extra Data
    if (tile.extraImageData && tile.tileHeader && tile.tileHeader.has_extra_data) {
        const ex = Math.round(lx + tile.extraX);
        const ey = Math.round(ly + tile.extraY);
        const ew = tile.tileHeader.cx_extra;
        const eh = tile.tileHeader.cy_extra;
        for (let y = 0; y < eh; y++) {
            const outY = ey + y;
            if (outY < 0 || outY >= h) continue;
            const srcRow = y * ew;
            const destRow = outY * w;
            for (let x = 0; x < ew; x++) {
                const outX = ex + x;
                if (outX >= 0 && outX < w) {
                    const idx = tile.extraImageData[srcRow + x];
                    if (idx !== 0) buffer[destRow + outX] = idx;
                }
            }
        }
    }

    // 3. Floating Selection
    if (state.floatingSelection && state.tiles[state.currentTileIdx] === tile) {
        const fs = state.floatingSelection;
        const fsX = Math.floor(fs.x);
        const fsY = Math.floor(fs.y);
        const fsW = fs.w || fs.width;
        const fsH = fs.h || fs.height;
        for (let fy = 0; fy < fsH; fy++) {
            const rowSrc = fy * fsW;
            const outY = fsY + fy;
            if (outY < 0 || outY >= h) continue;
            const rowDest = outY * w;
            for (let fx = 0; fx < fsW; fx++) {
                const outX = fsX + fx;
                if (outX >= 0 && outX < w) {
                    const val = fs.data[rowSrc + fx];
                    if (val !== TRANSPARENT_COLOR) buffer[rowDest + outX] = val;
                }
            }
        }
    }
    return buffer;
}

export function getActiveLayer() {
    const tile = state.tiles[state.currentTileIdx];
    if (!tile) return null;
    // For TMP editor, we treat the tile itself as the "active layer" 
    // to maintain compatibility with tools ported from the SHP editor.
    return tile;
}

export const getLayerDataSnapshot = getTileDataSnapshot;








export function updateSelectionUI() {
    const hasSelection = !!(state.selection || state.floatingSelection);



    // Update selection dimensions in status bar
    if (elements.statusSelectionInfo) {
        if (hasSelection) {
            const sel = state.selection || state.floatingSelection;
            const w = Math.round(sel.w);
            const h = Math.round(sel.h);

            if (elements.selectionDisplay) {
                if (elements.selectionDisplay) elements.selectionDisplay.innerText = `${w} × ${h}`;
            }
            elements.statusSelectionInfo.style.display = 'flex';
        } else {
            elements.statusSelectionInfo.style.display = 'none';
        }
    }

    // Enable/disable flip & rotate Selection scope menu items via the central updateMenuState
    if (typeof updateMenuState === 'function') updateMenuState(state.tiles.length > 0);
}

export function renderOverlay(x, y, tool, startPos) {
    if (arguments.length === 0) {
        x = state.currentX;
        y = state.currentY;
        tool = activeTool;
        if (state.isSelecting) {
            startPos = state.startSel;
        } else if (isDrawing && (tool === 'line' || tool === 'rect')) {
            startPos = lastPos;
        } else {
            startPos = null;
        }
    }
    const isCurrentlyDrawing = !!startPos;
     const ctx = elements.overlayCtx;
     if (!ctx) return;
     const z = state.zoom;

    // Ensure we clear the entire physical canvas, regardless of current world bounds
    ctx.clearRect(0, 0, elements.overlayCanvas.width, elements.overlayCanvas.height);

    // Tile highlights are now drawn pixel-art style in renderCanvas

    // Brush Cursor




    // Selection Overlay (Restored Legacy Implementation)

    // Helper: Draw Pixel Line for Lasso Preview (High Contrast)
    const drawPixelLine = (p1, p2) => {
        const points = bresenham(p1.x, p1.y, p2.x, p2.y);
        points.forEach(p => {
            // Draw block with contrast
            const sx = p.x * z;
            const sy = p.y * z;
            const sz = z;
            ctx.fillStyle = '#fff';
            ctx.fillRect(sx, sy, sz, sz);
            ctx.lineWidth = 1;
            ctx.strokeStyle = '#000';
            ctx.strokeRect(sx + 0.5, sy + 0.5, Math.max(1, sz - 1), Math.max(1, sz - 1));
        });
    };

    // Helper: Draw Selection Border from Mask (Sierra/Stepped)
    const drawSelectionMaskBorder = (mask, bx, by, bw, bh) => {
        // No Fill - Absolutely Transparent

        ctx.save();
        ctx.lineJoin = 'miter';
        ctx.lineWidth = 1;

        const path = new Path2D();
        const sx = bx * z;
        const sy = by * z;

        // Horizontal Segments (Top and Bottom edges)
        for (let my = 0; my < bh; my++) {
            let topStart = -1;
            let bottomStart = -1;
            for (let mx = 0; mx <= bw; mx++) {
                const isSelected = mx < bw && mask[my * bw + mx];

                // Top Edge
                const hasTop = isSelected && (my === 0 || !mask[(my - 1) * bw + mx]);
                if (hasTop && topStart === -1) topStart = mx;
                if (!hasTop && topStart !== -1) {
                    path.moveTo(sx + topStart * z, sy + my * z + 0.5);
                    path.lineTo(sx + mx * z, sy + my * z + 0.5);
                    topStart = -1;
                }

                // Bottom Edge
                const hasBottom = isSelected && (my === bh - 1 || !mask[(my + 1) * bw + mx]);
                if (hasBottom && bottomStart === -1) bottomStart = mx;
                if (!hasBottom && bottomStart !== -1) {
                    path.moveTo(sx + bottomStart * z, sy + (my + 1) * z - 0.5);
                    path.lineTo(sx + mx * z, sy + (my + 1) * z - 0.5);
                    bottomStart = -1;
                }
            }
        }

        // Vertical Segments (Left and Right edges)
        for (let mx = 0; mx < bw; mx++) {
            let leftStart = -1;
            let rightStart = -1;
            for (let my = 0; my <= bh; my++) {
                const isSelected = my < bh && mask[my * bw + mx];

                // Left Edge
                const hasLeft = isSelected && (mx === 0 || !mask[my * bw + (mx - 1)]);
                if (hasLeft && leftStart === -1) leftStart = my;
                if (!hasLeft && leftStart !== -1) {
                    path.moveTo(sx + mx * z + 0.5, sy + leftStart * z);
                    path.lineTo(sx + mx * z + 0.5, sy + my * z);
                    leftStart = -1;
                }

                // Right Edge
                const hasRight = isSelected && (mx === bw - 1 || !mask[my * bw + (mx + 1)]);
                if (hasRight && rightStart === -1) rightStart = my;
                if (!hasRight && rightStart !== -1) {
                    path.moveTo(sx + (mx + 1) * z - 0.5, sy + rightStart * z);
                    path.lineTo(sx + (mx + 1) * z - 0.5, sy + my * z);
                    rightStart = -1;
                }
            }
        }

        // 1. Black Background
        ctx.lineDashOffset = (state.selectionDashOffset || 0) - 4;
        ctx.strokeStyle = '#000';
        ctx.setLineDash([4, 4]);
        ctx.stroke(path);

        // 2. White Foreground
        ctx.lineDashOffset = state.selectionDashOffset || 0;
        ctx.strokeStyle = '#fff';
        ctx.setLineDash([4, 4]);
        ctx.stroke(path);

        ctx.restore();
    };

    // Selection Overlay (Scalable Grid Edge Style)
    const drawLegacyRect = (rx, ry, rw, rh) => {
        const sx = rx * z;
        const sy = ry * z;
        const sw = rw * z;
        const sh = rh * z;

        // Semi-transparent Fill Removed

        // Moving Black Dashes (Background for contrast)
        ctx.lineDashOffset = (state.selectionDashOffset || 0) - 4;
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1; // Hairline 1px
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(sx + 0.5, sy + 0.5, sw - 1, sh - 1);

        // Moving White Dashes (Foreground)
        ctx.lineDashOffset = state.selectionDashOffset || 0;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(sx + 0.5, sy + 0.5, sw - 1, sh - 1);

        if (activeTool === 'movePixels') {
            drawSelectionHandles(rx, ry, rw, rh);
        }
    };

    const drawSelectionHandles = (rx, ry, rw, rh) => {
        const handleSize = 6;
        const hs = handleSize / 2;
        const sx = rx * z;
        const sy = ry * z;
        const sw = rw * z;
        const sh = rh * z;

        // Handles positions (screen space)
        const positions = [
            [sx, sy], [sx + sw / 2, sy], [sx + sw, sy],
            [sx, sy + sh / 2], [sx + sw, sy + sh / 2],
            [sx, sy + sh], [sx + sw / 2, sy + sh], [sx + sw, sy + sh]
        ];

        ctx.setLineDash([]);
        ctx.lineWidth = 1;
        positions.forEach(([px, py]) => {
            ctx.beginPath();
            ctx.arc(px + 0.5, py + 0.5, handleSize / 2, 0, Math.PI * 2);
            ctx.fillStyle = '#fff';
            ctx.fill();
            ctx.strokeStyle = '#000';
            ctx.stroke();
        });
    };

    // 2. Draw "Finished" Selection (Static/Animated)
    try {
        if (state.selection) {
            if (state.selection.type === 'rect') {
                drawLegacyRect(state.selection.x, state.selection.y, state.selection.w, state.selection.h);
            } else if (state.selection.type === 'mask') {
                // Pure Mask (Magic Wand)
                drawSelectionMaskBorder(state.selection.maskData, state.selection.x, state.selection.y, state.selection.w, state.selection.h);
                if (activeTool === 'movePixels') drawSelectionHandles(state.selection.x, state.selection.y, state.selection.w, state.selection.h);
            } else if (state.selection.type === 'lasso') {
                // Lasso (Points + Mask)
                // Prefer Mask for Sierra Edge
                if (state.selection.maskData) {
                    drawSelectionMaskBorder(state.selection.maskData, state.selection.x, state.selection.y, state.selection.w, state.selection.h);
                    if (activeTool === 'movePixels') drawSelectionHandles(state.selection.x, state.selection.y, state.selection.w, state.selection.h);
                } else if (state.selection.points) {
                    // Fallback if no mask? (Should not happen per logic)
                    // Just ignored.
                }
            }
        }
    } catch (e) {
        console.error("Error drawing selection:", e);
    }

    // 1. Draw "Drawing" State (Pending Selection)
    if (isCurrentlyDrawing) {
        if (tool === 'select' && startPos && startPos.x !== undefined) {
            const sx = startPos.x;
            const sy = startPos.y;
            // Inclusive Bounds
            const x0 = Math.min(sx, x);
            const y0 = Math.min(sy, y);
            const w = Math.abs(x - sx) + 1;
            const h = Math.abs(y - sy) + 1;

            // Manual Draw Pending Rect (Standard Visibility)
            const screenX = x0 * z;
            const screenY = y0 * z;
            const screenW = w * z;
            const screenH = h * z;

            // Black Background
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 1;
            ctx.lineDashOffset = (state.selectionDashOffset || 0) - 4;
            ctx.setLineDash([4, 4]);
            ctx.strokeRect(screenX + 0.5, screenY + 0.5, screenW - 1, screenH - 1);

            // White Foreground
            ctx.strokeStyle = '#fff';
            ctx.lineDashOffset = state.selectionDashOffset || 0;
            ctx.setLineDash([4, 4]);
            ctx.strokeRect(screenX + 0.5, screenY + 0.5, screenW - 1, screenH - 1);

        } else if (tool === 'lasso' && state.startSel && state.startSel.length > 0) {
            const pts = [...state.startSel];

            // Fill Preview Removed

            // Draw Pixelated Lines for Lasso Preview
            for (let i = 0; i < pts.length - 1; i++) {
                drawPixelLine(pts[i], pts[i + 1]);
            }
            // Line to current cursor
            if (x !== undefined && y !== undefined) {
                drawPixelLine(pts[pts.length - 1], { x, y });
            }
        }
    }

    // Center Guides
    if (state.showCenter) {
        ctx.save();
        ctx.setLineDash([5, 5]);
        ctx.strokeStyle = '#00ffff'; // Cyan
        ctx.lineWidth = 1;

        // Vertical Center
        const centerX = (state.canvasW / 2) * z;
        ctx.beginPath();
        ctx.moveTo(centerX, 0);
        ctx.lineTo(centerX, h);
        ctx.stroke();

        // Horizontal Center
        const centerY = (state.canvasH / 2) * z;
        ctx.beginPath();
        ctx.moveTo(0, centerY);
        ctx.lineTo(w, centerY);
        ctx.stroke();
        ctx.restore();
    }

    // Sync button states
    updateSelectionUI();
}

// --- CELL MANAGER (Virtualized List) ---
let _tilesListRenderPending = false;

export function updateTilesList() {
    if (_tilesListRenderPending) return;
    _tilesListRenderPending = true;
    requestAnimationFrame(() => {
        _tilesListRenderPending = false;
        _updateTilesListImmediate();
        updateTileProperties(); 
        updateTileDataTable(); // NEW: Keep data table in sync
    });
}

function _updateTilesListImmediate() {
    if (!elements.tilesList) return;

    if (!elements.tilesList._hasScrollListener) {
        elements.tilesList.tabIndex = 0; // Make list focusable for shortcuts
        elements.tilesList.addEventListener('click', (e) => {
            if (e.target === elements.tilesList) {
                selectTile(-1);
            }
        });
        elements.tilesList.addEventListener('keydown', (e) => {
            if (e.ctrlKey || e.metaKey) {
                if (e.key === 'a' || e.key === 'A') {
                    e.preventDefault();
                    e.stopPropagation();
                    selectAllTiles();
                } else if (e.key === 'i' || e.key === 'I') {
                    e.preventDefault();
                    e.stopPropagation();
                    invertTileSelection();
                }
            }
        });

        elements.tilesList._hasScrollListener = true;
    }

    // Filter populated tiles for the sidebar
    const populated = state.tiles
        .map((tile, originalIdx) => ({ tile, originalIdx }))
        .filter(item => {
            // Keep only valid tiles to prevent crashes, but show all valid ones for debugging
            return item.tile && item.tile.tileHeader !== null;
        });

    const items = [];

    populated.forEach((itemInfo, displayIdx) => {
        const { tile, originalIdx } = itemInfo;

        // 1. Base Entry (8px top/bottom padding + border = 18px total logic)
        const pH_base = state.cy;
        const h0 = Math.max(42, pH_base + 18);

        items.push({
            tile,
            originalIdx,
            displayIdx,
            subType: 'base',
            h: h0,
            key: `${originalIdx}_base`
        });

        // 2. Extra Entry (8px top/bottom padding + border = 18px total logic)
        if (tile.tileHeader.has_extra_data && (tile.extraImageData || tile.extraZData)) {
            const pH_extra = tile.tileHeader.cy_extra;
            const h1 = Math.max(42, pH_extra + 18);

            items.push({
                tile,
                originalIdx,
                displayIdx,
                subType: 'extra',
                h: h1,
                key: `${originalIdx}_extra`
            });
        }
    });

    // Final Redraw: Complete flush for stability after large operations (Paste, Load)
    const forceFullRedraw = true; // Forcing for now as per user refresh issues
    if (forceFullRedraw) {
        elements.tilesList.innerHTML = "";
    }

    const currentDOMItems = forceFullRedraw ? [] : Array.from(elements.tilesList.children);
    const existingByKey = {};
    currentDOMItems.forEach(child => {
        existingByKey[child.dataset.key] = child;
    });

    // Ensure all items exist and are in the correct order
    items.forEach((itemInfo, i) => {
        let itemEl = existingByKey[itemInfo.key];
        if (!itemEl) {
            itemEl = _createTileItem(itemInfo);
            elements.tilesList.appendChild(itemEl);
        }
        _updateTileItem(itemEl, itemInfo);
    });

    // Update Toolbar State
    const hasSelection = state.tileSelection.size > 0;
    if (elements.btnDeleteTile) elements.btnDeleteTile.disabled = !hasSelection || state.tiles.length <= 1;
    if (elements.btnDuplicateTile) elements.btnDuplicateTile.disabled = !hasSelection;
    if (elements.btnMoveTilesUp) elements.btnMoveTilesUp.disabled = !hasSelection;
    if (elements.btnMoveMode) {
        // PERMIT persistent Move Mode even if selection is temporarily lost
        elements.btnMoveMode.classList.toggle('active', state.moveMode);
        elements.btnMoveMode.style.backgroundColor = state.moveMode ? 'var(--accent)' : '';
        elements.btnMoveMode.style.color = state.moveMode ? '#000' : '';
    }

    // Global UI Sync
    if (typeof window.updateUIState === 'function') window.updateUIState();
    
    // Auto-sync Data Table if visible during this update
    if (elements.tileDataTablePanel && elements.tileDataTablePanel.style.display !== 'none') {
        updateTileDataTable();
    }
}

function _createTileItem(itemInfo) {
    const { originalIdx, top, h, subType, key } = itemInfo;
    const tile = state.tiles[originalIdx];
    const div = document.createElement('div');
    div.className = 'layer-item';
    if (subType === 'extra') div.classList.add('hooked-layer');
    div.dataset.idx = originalIdx;
    div.dataset.key = key;
    div.dataset.subType = subType;
    // div.style.width = '100%'; // Replaced by CSS rule
    div.style.height = h + 'px';
    div.style.overflow = 'hidden';
    div.style.marginBottom = '4px';
    div.draggable = (subType === 'base' || (!state.bondSelection && subType === 'extra'));

    div.onclick = (e) => {
        const isCtrl = e.ctrlKey || e.metaKey;
        const isShift = e.shiftKey;
        selectTilePart(originalIdx, subType, isCtrl, isShift);
    };

    // Drag-Drop handlers
    div.ondragstart = (e) => {
        if (subType === 'extra' && state.bondSelection) {
            e.preventDefault();
            return;
        }
        
        if (!state.tileSelection.has(originalIdx)) {
            // Select correctly based on current mode
            selectTilePart(originalIdx, subType, false, false);
        }
        
        const dragType = (subType === 'extra') ? 'tile-extra' : 'tile';
        e.dataTransfer.setData('text/plain', dragType);
        e.dataTransfer.setData(dragType, originalIdx.toString());
        e.dataTransfer.setData('source-idx', originalIdx.toString());
        e.dataTransfer.effectAllowed = 'copyMove';
        div.classList.add('dragging');
    };

    div.ondragend = () => {
        div.classList.remove('dragging');
        document.querySelectorAll('.layer-item').forEach(el => el.classList.remove('drag-over'));
    };

    div.ondragover = (e) => {
        // More robust type checking (some browsers lowercase custom types)
        const types = Array.from(e.dataTransfer.types || []);
        const isExtraDrag = types.includes('tile-extra');
        
        if (isExtraDrag) {
            // Only highlight if target is a base cell WITHOUT extra data
            if (subType === 'base' && !tile.tileHeader.has_extra_data) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move'; // Matches the 'move' capability of the source
                div.classList.add('implant-target');
            }
            return;
        }

        // Standard reordering (Tile to Tile)
        if (subType !== 'base') return; 
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        div.classList.add('drag-over');
    };

    div.ondragleave = () => {
        div.classList.remove('drag-over');
        div.classList.remove('implant-target');
    };

    div.ondrop = (e) => {
        div.classList.remove('drag-over');
        div.classList.remove('implant-target');
        
        if (subType !== 'base') return; 
        e.preventDefault();
        const type = e.dataTransfer.getData('text/plain');
        const srcIdx = parseInt(e.dataTransfer.getData('source-idx'));
        
        if (type === 'tile') {
            reorderTiles(originalIdx);
        } else if (type === 'tile-extra') {
            if (isNaN(srcIdx)) return;
            const targetTile = state.tiles[originalIdx];
            if (targetTile && !targetTile.tileHeader.has_extra_data) {
                implantExtraData(srcIdx, originalIdx);
            }
        }
    };

    // 1. Index Number (BEFORE preview)
    const name = document.createElement('div');
    name.className = 'layer-item-name';
    name.style.pointerEvents = 'none';
    name.style.width = '30px';
    name.style.flex = 'none';
    div.appendChild(name);

    // 2. Previews Container (Image and Mask, XCC Style)
    const previewContainer = document.createElement('div');
    previewContainer.className = 'layer-preview-container';
    previewContainer.style.display = 'flex';
    previewContainer.style.alignItems = 'center';
    previewContainer.style.justifyContent = 'space-between';
    previewContainer.style.flex = '1';
    previewContainer.style.overflow = 'hidden';
    previewContainer.style.paddingRight = '8px';
    div.appendChild(previewContainer);

    // Image Preview
    const preview = document.createElement('canvas');
    preview.className = 'tile-image-preview';
    preview.style.pointerEvents = 'none';
    preview.style.width = 'auto';
    preview.style.height = 'auto';
    preview.style.maxWidth = '100%';
    preview.style.maxHeight = '100%';
    preview.style.imageRendering = 'pixelated';
    preview.style.flexShrink = '0';

    // Mask Preview (Z-Data)
    const maskPreview = document.createElement('canvas');
    maskPreview.className = 'tile-mask-preview';
    maskPreview.style.pointerEvents = 'none';
    maskPreview.style.width = 'auto';
    maskPreview.style.height = 'auto';
    maskPreview.style.maxWidth = '100%';
    maskPreview.style.maxHeight = '100%';
    maskPreview.style.imageRendering = 'pixelated';
    maskPreview.style.flexShrink = '0';

    const pW = (subType === 'base') ? state.cx : (tile.tileHeader ? tile.tileHeader.cx_extra : tile.width);
    const pH = (subType === 'base') ? state.cy : (tile.tileHeader ? tile.tileHeader.cy_extra : tile.height);

    preview.width = pW || 1;
    preview.height = pH || 1;
    maskPreview.width = pW || 1;
    maskPreview.height = pH || 1;

    previewContainer.appendChild(preview);
    previewContainer.appendChild(maskPreview);

    // 3. Sub-label (Shifted right) - HIDDEN as per user request
    const subLabel = document.createElement('div');
    subLabel.className = 'layer-item-sublabel';
    subLabel.style.display = 'none';
    div.appendChild(subLabel);

    return div;
}

function _updateTileItem(itemEl, itemInfo) {
    const { originalIdx, top, h, subType, key } = itemInfo;
    const tile = state.tiles[originalIdx];
    if (!tile) return;

    // Selection logic
    let isSelected = false;
    let isActive = false;

    if (state.bondSelection) {
        isSelected = state.tileSelection.has(originalIdx);
        isActive = (state.currentTileIdx === originalIdx);
    } else {
        isSelected = state.subSelection.has(key);
        isActive = (state.currentTileKey === key);
    }

    itemEl.classList.toggle('selected', isSelected);
    itemEl.classList.toggle('overlapping', state.overlappingTiles && state.overlappingTiles.has(originalIdx));
    
    // RED ALERT: Extra Data Mismatch (Priority 1)
    const mismatch = (subType === 'extra' && _isExtraDataMismatched(tile));
    itemEl.classList.toggle('mismatch-error', mismatch);

    // Active highlight rule applies only to specific sub-types
    itemEl.classList.toggle('active', isActive && subType === 'extra');

    itemEl.style.height = h + 'px';

    const name = itemEl.querySelector('.layer-item-name');
    const subLabel = itemEl.querySelector('.layer-item-sublabel');

    const pW = (subType === 'base') ? state.cx : (tile.tileHeader ? tile.tileHeader.cx_extra : tile.width);
    const pH = (subType === 'base') ? state.cy : (tile.tileHeader ? tile.tileHeader.cy_extra : tile.height);

    name.textContent = (subType === 'base') ? `${itemInfo.displayIdx}` : '';
    subLabel.textContent = '';

    // --- Dimension Tooltip ---
    // Build a multi-line tooltip that shows dimension info depending on BOND state and hover context.
    {
        const h = tile.tileHeader;
        const isBond = state.bondSelection;
        const lines = [];

        // Cell base dimensions (always the game-standard cx x cy)
        const cellW = state.cx || 48;
        const cellH = state.cy || 24;

        if (isBond || subType === 'base') {
            lines.push(`Cell: ${cellW} × ${cellH} px`);
        }

        // Extra data dimensions — show when tile has extra and (bond OR hovering over extra sub-item)
        if (h && h.has_extra_data && (isBond || subType === 'extra')) {
            // Determine per-layer independent dims
            const imgCx = tile._extraImg_cx || h.cx_extra || 0;
            const imgCy = tile._extraImg_cy || h.cy_extra || 0;
            const zCx   = tile._extraZ_cx  || h.cx_extra || 0;
            const zCy   = tile._extraZ_cy  || h.cy_extra || 0;

            const imgLen = tile.extraImageData ? tile.extraImageData.length : 0;
            const zLen   = tile.extraZData     ? tile.extraZData.length     : 0;

            const imgHasDims = imgLen > 0 && imgCx > 0 && imgCy > 0;
            const zHasDims   = zLen   > 0 && zCx   > 0 && zCy   > 0;

            const dimsMatch = imgHasDims && zHasDims && imgCx === zCx && imgCy === zCy;

            if (dimsMatch) {
                // Both match — show a single Extra Data line
                lines.push(`Extra Data: ${imgCx} × ${imgCy} px`);
            } else {
                // Mismatch or only one layer exists — show each independently
                if (imgHasDims) lines.push(`Extra Data (Image): ${imgCx} × ${imgCy} px`);
                if (zHasDims)   lines.push(`Extra Data (Z-Data): ${zCx} × ${zCy} px`);
                if (!imgHasDims && !zHasDims && (h.cx_extra || h.cy_extra)) {
                    lines.push(`Extra Data: ${h.cx_extra || '?'} × ${h.cy_extra || '?'} px`);
                }
            }
        }

        itemEl.title = ''; // Clear native title to prevent double-tooltip
        // Use the unified uiTooltip system (setupTooltips) via data-tooltip attribute.
        // This gives consistent delay, positioning and cleanup across all controls.
        itemEl.setAttribute('data-tooltip', lines.join('\n'));
    }

    const canvas = itemEl.querySelector('.tile-image-preview');
    const maskCanvas = itemEl.querySelector('.tile-mask-preview');
    if (!canvas || !maskCanvas) return;

    // Sync canvas buffer dimensions to the current tile (critical for virtualised reuse)
    // For Mismatches, we use the specific buffer dimensions to avoid 'scrambled' look
    const bW_img = (subType === 'extra' && tile._extraImg_cx && tile.extraImageData?.length >= tile._extraImg_cx * tile._extraImg_cy) ? tile._extraImg_cx : pW;
    const bH_img = (subType === 'extra' && tile._extraImg_cy && tile.extraImageData?.length >= tile._extraImg_cx * tile._extraImg_cy) ? tile._extraImg_cy : pH;
    
    const bW_z = (subType === 'extra' && tile._extraZ_cx && tile.extraZData?.length >= tile._extraZ_cx * tile._extraZ_cy) ? tile._extraZ_cx : pW;
    const bH_z = (subType === 'extra' && tile._extraZ_cy && tile.extraZData?.length >= tile._extraZ_cx * tile._extraZ_cy) ? tile._extraZ_cy : pH;

    if (canvas.width !== bW_img || canvas.height !== bH_img) {
        canvas.width = bW_img;
        canvas.height = bH_img;
    }
    if (maskCanvas.width !== bW_z || maskCanvas.height !== bH_z) {
        maskCanvas.width = bW_z;
        maskCanvas.height = bH_z;
    }

    const ctx = canvas.getContext('2d');
    const mCtx = maskCanvas.getContext('2d');

    // Image – draw at exact 1:1 pixel size
    ctx.clearRect(0, 0, bW_img, bH_img);
    renderTileThumbnail(tile, ctx, bW_img, bH_img, false, false, subType);

    // Mask (Z-Data logic)
    // Clear and draw mask using the standardized thumbnail renderer
    mCtx.fillStyle = '#000';
    mCtx.fillRect(0, 0, bW_z, bH_z);
    
    // Base/Extra Z views: Always opaque black background for UI list previews
    renderTileThumbnail(tile, mCtx, bW_z, bH_z, false, false, subType + 'Z');
}


export function selectTilePart(idx, subType, isCtrl, isShift) {
    const key = `${idx}_${subType}`;

    if (state.bondSelection) {
        // Normal behavior: selecting either part selects the whole group
        if (isShift && state.currentTileIdx !== -1) {
            selectTileRange(state.currentTileIdx, idx);
        } else if (isCtrl) {
            toggleTileSelection(idx);
        } else {
            selectTile(idx);
        }
    } else {
        // Decoupled behavior: select individual entries
        if (isCtrl) {
            if (state.subSelection.has(key)) {
                state.subSelection.delete(key);
            } else {
                state.subSelection.add(key);
                state.currentTileKey = key;
            }
        } else {
            state.subSelection.clear();
            state.subSelection.add(key);
            state.currentTileKey = key;
        }

        // Keep standard tile selection roughly in sync for legacy stuff (canvas rendering)
        state.tileSelection.clear();
        state.subSelection.forEach(k => {
            const pid = parseInt(k.split('_')[0]);
            state.tileSelection.add(pid);
        });
        state.currentTileIdx = idx;
    }

    updateTilesList();
    scrollTileIntoView(key);
    updateExtraBtnState();
    updateTileProperties();
    updateTileDataTable();
    
    requestAnimationFrame(() => {
        updateCanvasSize();
        renderCanvas();
    });
    
    pushHistory([]);
}

function scrollTileIntoView(key) {
    if (!elements.tilesList) return;
    const populated = state.tiles
        .map((tile, originalIdx) => ({ tile, originalIdx }))
        .filter(item => item.tile && item.tile.tileHeader !== null);

    let itemsInfo = [];
    let currentTop = 0;
    populated.forEach(info => {
        const { tile, originalIdx } = info;
        const h0 = Math.max(42, state.cy + 18);
        itemsInfo.push({ key: `${originalIdx}_base`, top: currentTop, h: h0 });
        currentTop += h0 + 4;

        if (tile.tileHeader.has_extra_data && tile.extraImageData) {
            const h1 = Math.max(42, tile.tileHeader.cy_extra + 18);
            itemsInfo.push({ key: `${originalIdx}_extra`, top: currentTop, h: h1 });
            currentTop += h1 + 4;
        }
    });

    const target = itemsInfo.find(it => it.key === key);
    if (!target) return;

    const st = elements.tilesList.scrollTop;
    const ch = elements.tilesList.clientHeight;

    if (target.top < st) {
        elements.tilesList.scrollTop = target.top - 10;
    } else if (target.top + target.h > st + ch) {
        elements.tilesList.scrollTop = target.top + target.h - ch + 10;
    }
}

export function selectTile(idx) {
    if (state.floatingSelection) commitSelection();

    state.currentTileIdx = idx;
    state.tileSelection.clear();
    state.subSelection.clear();
    if (idx !== -1) {
        state.tileSelection.add(idx);
        state.subSelection.add(`${idx}_base`);
        state.currentTileKey = `${idx}_base`;
        selectTileBounds(idx);
    } else {
        state.currentTileKey = null;
    }

    updateTilesList();
    updateExtraBtnState();
    updateTileProperties();
    
    // Ensure the browser has completed any layout shifts (sidebar hiding) before updating bounds and rendering
    requestAnimationFrame(() => {
        updateCanvasSize();
        renderCanvas();
    });
    
    pushHistory([]);
}

export function toggleTileSelection(idx) {
    if (state.tileSelection.has(idx)) {
        state.tileSelection.delete(idx);
        state.subSelection.delete(`${idx}_base`);
        state.subSelection.delete(`${idx}_extra`);
        if (state.currentTileIdx === idx) {
            state.currentTileIdx = state.tileSelection.size > 0 ? Array.from(state.tileSelection)[0] : -1;
            state.currentTileKey = state.tileSelection.size > 0 ? `${state.currentTileIdx}_base` : null;
        }
    } else {
        state.tileSelection.add(idx);
        state.currentTileIdx = idx;
        state.subSelection.add(`${idx}_base`);
        state.currentTileKey = `${idx}_base`;
        selectTileBounds(idx);
    }
    updateTilesList();
    updateExtraBtnState();
    updateTileProperties();
    
    requestAnimationFrame(() => {
        updateCanvasSize();
        renderCanvas();
    });
    
    pushHistory([]);
}

export function selectTileRange(start, end) {
    const populated = state.tiles
        .map((t, i) => ({ t, i }))
        .filter(item => item.t && item.t.tileHeader !== null);

    const visualStart = populated.findIndex(p => p.i === start);
    const visualEnd = populated.findIndex(p => p.i === end);

    if (visualStart === -1 || visualEnd === -1) return;

    const low = Math.min(visualStart, visualEnd);
    const high = Math.max(visualStart, visualEnd);

    state.tileSelection.clear();
    for (let i = low; i <= high; i++) {
        state.tileSelection.add(populated[i].i);
    }
    state.currentTileIdx = end;
    selectTileBounds(end);

    updateTilesList();
    updateExtraBtnState();
    updateTileProperties();

    requestAnimationFrame(() => {
        updateCanvasSize();
        renderCanvas();
    });

    pushHistory([]);
}

/**
 * Selects all visible (populated) tiles in the project.
 */
export function selectAllTiles() {
    const pop = _getVisibleItems();
    state.tileSelection.clear();
    state.subSelection.clear();
    pop.forEach(info => {
        state.tileSelection.add(info.originalIdx);
        state.subSelection.add(`${info.originalIdx}_base`);
        if (state.tiles[info.originalIdx].tileHeader.has_extra_data) {
            state.subSelection.add(`${info.originalIdx}_extra`);
        }
    });
    if (pop.length > 0) state.currentTileIdx = pop[0].originalIdx;
    updateTilesList();
    updateExtraBtnState();
    updateTileProperties();

    requestAnimationFrame(() => {
        updateCanvasSize();
        renderCanvas();
    });

    pushHistory([]);
}

/**
 * Inverts the current project tile selection.
 */
export function invertTileSelection() {
    const pop = _getVisibleItems();
    const oldSel = new Set(state.tileSelection);
    state.tileSelection.clear();
    state.subSelection.clear();
    let first = -1;
    pop.forEach(info => {
        if (!oldSel.has(info.originalIdx)) {
            state.tileSelection.add(info.originalIdx);
            state.subSelection.add(`${info.originalIdx}_base`);
            if (state.tiles[info.originalIdx].tileHeader.has_extra_data) {
                state.subSelection.add(`${info.originalIdx}_extra`);
            }
            if (first === -1) first = info.originalIdx;
        }
    });
    state.currentTileIdx = first;
    updateTilesList();
    updateExtraBtnState();
    updateTileProperties();
    updateTileDataTable();

    requestAnimationFrame(() => {
        updateCanvasSize();
        renderCanvas();
    });

    pushHistory([]);
}

/**
 * Clears all current tile selections and updates relevant UI components.
 */
export function deselectAllTiles() {
    state.tileSelection.clear();
    state.subSelection.clear();
    state.currentTileIdx = -1;
    state.currentTileKey = null;
    updateTilesList();
    updateTileProperties();
    
    // Use RAF to ensure the layout shift (hiding the right panel) has settled before updating the viewport and rendering.
    requestAnimationFrame(() => {
        updateCanvasSize();
        renderCanvas();
    });

    updateExtraBtnState();
    updateTileDataTable();
    pushHistory([]);
}

function _getVisibleItems() {
    return state.tiles
        .map((tile, originalIdx) => ({ tile, originalIdx }))
        .filter(item => item.tile && item.tile.tileHeader !== null)
        .filter(item => {
            const t = item.tile;
            if (state.tileSelection.has(item.originalIdx)) return true;
            let eb = true;
            if (t.data) for (let i = 0; i < t.data.length; i++) if (t.data[i] !== TRANSPARENT_COLOR) { eb = false; break; }
            let ex = true;
            if (t.tileHeader && t.tileHeader.has_extra_data && t.extraImageData) {
                for (let i = 0; i < t.extraImageData.length; i++) if (t.extraImageData[i] !== TRANSPARENT_COLOR) { ex = false; break; }
            }
            return !(eb && ex);
        });
}


export function selectTileBounds(idx) {
    const tile = state.tiles[idx];
    if (!tile || !tile.tileHeader) return;

    // Clear standard marquee selection to focus on isometric highlight
    state.selection = null;
    renderOverlay();
}

export function reorderTiles(targetIdx) {
    if (state.tileSelection.size === 0) return;

    pushHistory();
    const selectedIndices = Array.from(state.tileSelection).sort((a, b) => a - b);
    const selectedTiles = selectedIndices.map(i => state.tiles[i]);

    // Capture which sub-parts were selected for each moved tile before moving them
    const selectionPatterns = selectedIndices.map(i => ({
        hasBase: state.subSelection.has(`${i}_base`),
        hasExtra: state.subSelection.has(`${i}_extra`)
    }));

    // Remove tiles from original positions
    for (let i = selectedIndices.length - 1; i >= 0; i--) {
        state.tiles.splice(selectedIndices[i], 1);
    }

    // Adjust target index if it was affected by removals
    let adjustedTarget = targetIdx;
    for (const idx of selectedIndices) {
        if (idx < targetIdx) adjustedTarget--;
    }

    // Insert at new position
    state.tiles.splice(adjustedTarget, 0, ...selectedTiles);

    // Restore selection
    state.tileSelection.clear();
    state.subSelection.clear();
    state.currentTileKey = null;

    for (let i = 0; i < selectedTiles.length; i++) {
        const newIdx = adjustedTarget + i;
        const pattern = selectionPatterns[i];

        state.tileSelection.add(newIdx);
        
        // Restore based on previous pattern or Bond mode
        if (pattern.hasBase || state.bondSelection) {
            const baseKey = `${newIdx}_base`;
            state.subSelection.add(baseKey);
            if (i === 0) {
                state.currentTileIdx = newIdx;
                state.currentTileKey = baseKey;
            }
        }
        
        if (pattern.hasExtra || (state.bondSelection && selectedTiles[i].tileHeader.has_extra_data)) {
            const extraKey = `${newIdx}_extra`;
            state.subSelection.add(extraKey);
            if (i === 0 && !state.currentTileKey) {
                state.currentTileIdx = newIdx;
                state.currentTileKey = extraKey;
            }
        }
    }

    updateTilesList();
    renderCanvas();
}

/**
 * Transfers Extra Data from one tile to another.
 * Used for the "implant" drag-and-drop feature.
 */
export function implantExtraData(srcIdx, destIdx) {
    if (srcIdx === destIdx) return;
    const srcTile = state.tiles[srcIdx];
    const destTile = state.tiles[destIdx];
    if (!srcTile || !destTile) return;
    if (!srcTile.tileHeader.has_extra_data) return;
    if (destTile.tileHeader.has_extra_data) return;

    pushHistory();
    
    // Transfer data buffers
    destTile.extraImageData = srcTile.extraImageData;
    destTile.extraZData = srcTile.extraZData;
    
    // Transfer header metadata
    destTile.tileHeader.has_extra_data = 1;
    destTile.tileHeader.cx_extra = srcTile.tileHeader.cx_extra;
    destTile.tileHeader.cy_extra = srcTile.tileHeader.cy_extra;
    
    // Keep exact original world coordinates
    destTile.tileHeader.x_extra = srcTile.tileHeader.x_extra;
    destTile.tileHeader.y_extra = srcTile.tileHeader.y_extra;
    
    // Cleanup source tile
    srcTile.tileHeader.has_extra_data = 0;
    srcTile.extraImageData = null;
    srcTile.extraZData = null;
    srcTile.tileHeader.cx_extra = 0;
    srcTile.tileHeader.cy_extra = 0;
    srcTile.tileHeader.x_extra = 0;
    srcTile.tileHeader.y_extra = 0;

    // Update selection to focus on the newly implanted data
    state.subSelection.clear();
    const newKey = `${destIdx}_extra`;
    state.subSelection.add(newKey);
    state.currentTileIdx = destIdx;
    state.currentTileKey = newKey;
    
    updateTilesList();
    updateTileProperties();
    renderCanvas();
}

export function findTileAt(x, y) {
    const viewBounds = state.viewBounds || state.worldBounds || { minX: 0, minY: 0 };
    const minX = viewBounds.minX;
    const minY = viewBounds.minY;
    const mult = state.cy / 2;

    for (let i = state.tiles.length - 1; i >= 0; i--) {
        const tile = state.tiles[i];
        if (!tile || !tile.tileHeader) continue;
        const h_tile = tile.tileHeader;

        // Base Data Check
        const dx = Math.round(tile.itemMinX + tile.diamondX - minX);
        const dy = Math.round(tile.itemMinY + tile.diamondY - minY);
        const cx = state.cx;
        const cy = state.cy;

        if (x >= dx && x < dx + cx && y >= dy && y < dy + cy) {
            const locX = Math.floor(x - dx);
            const locY = Math.floor(y - dy);
            let halfY = Math.floor(cy / 2);
            let ry = (locY < halfY) ? locY : (cy - 1 - locY - 1);
            if (ry >= 0) {
                const rowW = (ry + 1) * 4;
                const rowX = Math.floor(cx / 2) - (ry + 1) * 2;
                if (locX >= rowX && locX < rowX + rowW) return tile;
            }
        }
        
        // Extra Data Check
        if (h_tile.has_extra_data && tile.extraImageData) {
            const ex = Math.round(tile.itemMinX + tile.extraX - minX);
            const ey = Math.round(tile.itemMinY + tile.extraY - minY);
            if (x >= ex && x < ex + h_tile.cx_extra && y >= ey && y < ey + h_tile.cy_extra) {
                const lx = Math.floor(x - ex);
                const ly = Math.floor(y - ey);
                if (tile.extraImageData[ly * h_tile.cx_extra + lx] !== TRANSPARENT_COLOR) return tile;
            }
        }
    }
    return null;
}

export function pickTileIndexAt(x, y) {
    const viewBounds = state.viewBounds || state.worldBounds || { minX: 0, minY: 0 };
    const minX = viewBounds.minX;
    const minY = viewBounds.minY;

    for (let i = state.tiles.length - 1; i >= 0; i--) {
        const tile = state.tiles[i];
        if (!tile || !tile.tileHeader) continue;
        const h_tile = tile.tileHeader;

        // Extra Data Check first (usually on top)
        if (h_tile.has_extra_data && tile.extraImageData) {
            const ex = Math.round(tile.itemMinX + tile.extraX - minX);
            const ey = Math.round(tile.itemMinY + tile.extraY - minY);
            if (x >= ex && x < ex + h_tile.cx_extra && y >= ey && y < ey + h_tile.cy_extra) {
                const lx = Math.floor(x - ex);
                const ly = Math.floor(y - ey);
                const ew = h_tile.cx_extra;
                
                // Priority: Use Z-Data for hit test if present
                let hasHit = false;
                if (tile.extraZData) {
                    const z = tile.extraZData[ly * ew + lx];
                    if (z !== 0 && z !== 255) hasHit = true;
                }
                // Fallback: Image silhouette
                if (!hasHit && tile.extraImageData) {
                    if (tile.extraImageData[ly * ew + lx] !== TRANSPARENT_COLOR) hasHit = true;
                }

                if (hasHit) return i;
            }
        }

        // Base Data Check (Diamond hit-test)
        const dx = Math.round(tile.itemMinX + tile.diamondX - minX);
        const dy = Math.round(tile.itemMinY + tile.diamondY - minY);
        const cx = state.cx;
        const cy = state.cy;

        if (x >= dx && x < dx + cx && y >= dy && y < dy + cy) {
            const locX = Math.floor(x - dx);
            const locY = Math.floor(y - dy);
            let ry = (locY < cy / 2) ? locY : (cy - 1 - locY);
            if (ry >= 0) {
                const rowW = (ry + 1) * 4;
                const rowX = Math.floor(cx / 2) - (ry + 1) * 2;
                if (locX >= rowX && locX < rowX + rowW) return i;
            }
        }
    }
    return -1;
}

export function selectTileAt(x, y, isCtrl = false, isShift = false) {
    // TMP tiles can overlap. We iterate backwards to select the "top-most" one.
    const viewBounds = state.viewBounds || state.worldBounds || { minX: 0, minY: 0 };
    const minX = viewBounds.minX;
    const minY = viewBounds.minY;

    const mult = state.cy / 2;
    for (let i = state.tiles.length - 1; i >= 0; i--) {
        const tile = state.tiles[i];
        if (!tile || !tile.tileHeader) continue;

        const h_tile = tile.tileHeader;
        const elevation = state.flatCells ? 0 : h_tile.height * mult;

        // Check Extra Data first
        if (!state.flatCells && h_tile.has_extra_data && tile.extraImageData) {
            const ex = Math.round(tile.itemMinX + tile.extraX - minX);
            const ey = Math.round(tile.itemMinY + tile.extraY - minY);
            const ew = h_tile.cx_extra;
            const eh = h_tile.cy_extra;

            if (x >= ex && x < ex + ew && y >= ey && y < ey + eh) {
                const lx = Math.floor(x - ex);
                const ly = Math.floor(y - ey);
                
                let hasHit = false;
                if (tile.extraZData) {
                    const z = tile.extraZData[ly * ew + lx];
                    if (z !== 0 && z !== 255) hasHit = true;
                }
                if (!hasHit && tile.extraImageData) {
                    if (tile.extraImageData[ly * ew + lx] !== TRANSPARENT_COLOR) hasHit = true;
                }

                if (hasHit) {
                    selectTilePart(i, 'extra', isCtrl, isShift);
                    return true;
                }
            }
        }

        // Check Base Data - use diamond hit-test for isometric tiles
        const dx = Math.round(tile.itemMinX + tile.diamondX - minX);
        const dy = Math.round(tile.itemMinY + tile.diamondY - minY);
        const cx = state.cx;
        const cy = state.cy;

        if (x >= dx && x < dx + cx && y >= dy && y < dy + cy) {
            const locX = Math.floor(x - dx);
            const locY = Math.floor(y - dy);

            // XCC-style Diamond Mask Logic (4-pixel tip, matching _drawWestwoodDiamond)
            let halfY = Math.floor(cy / 2);
            let ry;
            if (locY < halfY) {
                ry = locY;
            } else {
                ry = cy - 1 - locY - 1;
            }

            if (ry >= 0) {
                const rowW = (ry + 1) * 4;
                const rowX = Math.floor(cx / 2) - (ry + 1) * 2;

                if (locX >= rowX && locX < rowX + rowW) {
                    console.log(`[Selection] Hit Base Tile ${i} at ${x},${y}`);
                    selectTilePart(i, 'base', isCtrl, isShift);
                    return true;
                }
            }
        }
    }

    console.log(`[Selection] No hit at ${x},${y}`);

    // Clicked on background
    if (!isCtrl && !isShift) {
        selectTile(-1);
    }
    return false;
}

/**
 * Selects all tiles (and sub-parts) that intersect with the given marquee rectangle.
 */
export function selectTilesInRect(x1, y1, x2, y2, isCtrl = false) {
    const rx = Math.min(x1, x2);
    const ry = Math.min(y1, y2);
    const rw = Math.abs(x2 - x1);
    const rh = Math.abs(y2 - y1);

    if (!isCtrl) {
        state.tileSelection.clear();
        state.subSelection.clear();
    }

    const viewBounds = state.viewBounds || state.worldBounds || { minX: 0, minY: 0 };
    const minX = viewBounds.minX;
    const minY = viewBounds.minY;
    const mult = state.cy / 2;

    let firstHit = -1;

    for (let i = 0; i < state.tiles.length; i++) {
        const tile = state.tiles[i];
        if (!tile || !tile.tileHeader) continue;
        const h = tile.tileHeader;

        const elevation = state.flatCells ? 0 : h.height * mult;
        
        // 1. Base Hit Test
        const bx = Math.round(tile.itemMinX + tile.diamondX - minX);
        const by = Math.round(tile.itemMinY + tile.diamondY - minY);
        const bcx = state.cx;
        const bcy = state.cy;

        const baseHits = (bx < rx + rw && bx + bcx > rx && by < ry + rh && by + bcy > ry);

        // 2. Extra Hit Test
        let extraHits = false;
        if (h.has_extra_data && tile.extraImageData) {
            const ex = Math.round(tile.itemMinX + tile.extraX - minX);
            const ey = Math.round(tile.itemMinY + tile.extraY - minY);
            const ecx = h.cx_extra;
            const ecy = h.cy_extra;
            extraHits = (ex < rx + rw && ex + ecx > rx && ey < ry + rh && ey + ecy > ry);
        }

        if (state.bondSelection) {
            if (baseHits || extraHits) {
                state.tileSelection.add(i);
                if (firstHit === -1) firstHit = i;
            }
        } else {
            // Decoupled: Select individual parts
            if (baseHits) {
                state.tileSelection.add(i);
                state.subSelection.add(`${i}_base`);
                if (firstHit === -1) firstHit = i;
            }
            if (extraHits) {
                state.tileSelection.add(i);
                state.subSelection.add(`${i}_extra`);
                if (firstHit === -1) firstHit = i;
            }
        }
    }

    if (firstHit !== -1 && !isCtrl) state.currentTileIdx = firstHit;

    updateTilesList();
    updateExtraBtnState();
    updateTileProperties();

    requestAnimationFrame(() => {
        updateCanvasSize();
        renderCanvas();
    });

    pushHistory([]);
}


export function moveSelectedTilesUp() {
    if (state.tileSelection.size === 0) return;
    const sorted = Array.from(state.tileSelection).sort((a, b) => a - b);
    
    // Get list of all visible (populated) indices to find neighbors correctly
    const visibleIndices = state.tiles
        .map((t, i) => ({ t, i }))
        .filter(item => item.t && item.t.tileHeader !== null && !_isTileEmpty(item.t))
        .map(item => item.i);

    if (visibleIndices.length === 0) return;

    let moved = false;
    const newTiles = [...state.tiles];
    const newSelection = new Set();

    // Move each selected tile up past the nearest visible neighbor
    for (const idx of sorted) {
        const currentVisiblePos = visibleIndices.indexOf(idx);
        if (currentVisiblePos > 0) {
            const targetIdx = visibleIndices[currentVisiblePos - 1];
            
            // Swap in array
            const temp = newTiles[targetIdx];
            newTiles[targetIdx] = newTiles[idx];
            newTiles[idx] = temp;
            
            newSelection.add(targetIdx);
            moved = true;

            // Update our temporary visibleIndices list to reflect the swap for next items in selection
            visibleIndices[currentVisiblePos] = targetIdx;
            visibleIndices[currentVisiblePos - 1] = idx;
        } else {
            newSelection.add(idx);
        }
    }

    if (moved) {
        pushHistory('all'); 
        state.tiles = newTiles;
        state.tileSelection = newSelection;
        state.currentTileIdx = Array.from(newSelection)[0];
        updateTilesList();
        renderCanvas();
    }
}

export function moveSelectedTilesDown() {
    if (state.tileSelection.size === 0) return;
    const sorted = Array.from(state.tileSelection).sort((a, b) => b - a);

    const visibleIndices = state.tiles
        .map((t, i) => ({ t, i }))
        .filter(item => item.t && item.t.tileHeader !== null && !_isTileEmpty(item.t))
        .map(item => item.i);

    if (visibleIndices.length === 0) return;

    let moved = false;
    const newTiles = [...state.tiles];
    const newSelection = new Set();

    for (const idx of sorted) {
        const currentVisiblePos = visibleIndices.indexOf(idx);
        if (currentVisiblePos !== -1 && currentVisiblePos < visibleIndices.length - 1) {
            const targetIdx = visibleIndices[currentVisiblePos + 1];
            
            const temp = newTiles[targetIdx];
            newTiles[targetIdx] = newTiles[idx];
            newTiles[idx] = temp;
            
            newSelection.add(targetIdx);
            moved = true;

            visibleIndices[currentVisiblePos] = targetIdx;
            visibleIndices[currentVisiblePos + 1] = idx;
        } else {
            newSelection.add(idx);
        }
    }

    if (moved) {
        pushHistory('all');
        state.tiles = newTiles;
        state.tileSelection = newSelection;
        state.currentTileIdx = Array.from(newSelection)[0];
        updateTilesList();
        renderCanvas();
    }
}

/**
 * Navigates to the next/previous tile in the visible list (sidebar/table)
 * Used by keyboard shortcuts when not in Move Mode.
 */
export function navigateTiles(dir) {
    const validIndices = state.tiles
        .map((t, i) => ({ t, i }))
        .filter(item => item.t && item.t.tileHeader !== null)
        .map(item => item.i);
    
    if (validIndices.length === 0) return;
    
    let currentIdx = (state.currentTileIdx !== -1) ? state.currentTileIdx : -1;
    let newIdx;
    
    if (currentIdx === -1) {
        newIdx = (dir > 0) ? validIndices[0] : validIndices[validIndices.length - 1];
    } else {
        const currentPos = validIndices.indexOf(currentIdx);
        let nextPos;
        if (currentPos === -1) {
            nextPos = 0;
        } else {
            nextPos = currentPos + dir;
            if (nextPos < 0) nextPos = 0;
            if (nextPos >= validIndices.length) nextPos = validIndices.length - 1;
        }
        newIdx = validIndices[nextPos];
    }
    
    if (newIdx !== currentIdx) {
        selectTilePart(newIdx, 'base', false, false);
    }
}

function _isTileEmpty(t) {
    if (!t) return true;
    
    if (t.data) {
        const len = t.data.length;
        for (let i = 0; i < len; i += 1) {
            if (t.data[i] !== 0) return false;
        }
    }
    if (t.tileHeader && t.tileHeader.has_extra_data && t.extraImageData) {
        const len = t.extraImageData.length;
        for (let i = 0; i < len; i += 1) {
            if (t.extraImageData[i] !== 0) return false;
        }
    }
    return true;
}

/**
 * Scans all tiles and updates the global mismatch notification bar.
 */
export function updateMismatchNotification() {
    const populatedMap = new Map();
    let displayIdx = 0;
    state.tiles.forEach((t, i) => {
        if (!t || !t.tileHeader) return;
        // Replicate logic from updateTilesList to find visible index
        let emptyBase = true;
        if (t.data) { for (let k = 0; k < t.data.length; k++) { if (t.data[k] !== TRANSPARENT_COLOR) { emptyBase = false; break; } } }
        let emptyExtra = true;
        if (t.tileHeader && t.tileHeader.has_extra_data && t.extraImageData) { for (let k = 0; k < t.extraImageData.length; k++) { if (t.extraImageData[k] !== TRANSPARENT_COLOR) { emptyExtra = false; break; } } }
        
        if (state.tileSelection.has(i) || !(emptyBase && emptyExtra)) {
             populatedMap.set(i, displayIdx++);
        }
    });

    const mismatches = [];
    state.tiles.forEach((t, i) => {
        if (_isExtraDataMismatched(t)) {
            const visibleIdx = populatedMap.has(i) ? populatedMap.get(i) : i; 
            mismatches.push(visibleIdx); // Match the sidebar index (0-based)
        }
    });

    state.hasMismatches = mismatches.length > 0;

    const bar = document.getElementById('mismatchNotification');
    const msg = document.getElementById('mismatchNotificationMsg');
    
    // Update menu state to disable Save/SaveAs if mismatches exist
    if (typeof window.updateMenuState === 'function') {
        window.updateMenuState(!!state.tmpData);
    }

    if (!bar || !msg) return;

    if (mismatches.length > 0) {
        msg.textContent = t('msg_mismatch_detected').replace('{{cells}}', mismatches.join(', '));
        bar.classList.add('active');
    } else {
        bar.classList.remove('active');
    }
}

/**
 * Validates Extra Data consistency.
 */
function _isExtraDataMismatched(tile) {
    if (!tile || !tile.tileHeader || !tile.tileHeader.has_extra_data) return false;
    
    const imgLen = tile.extraImageData ? tile.extraImageData.length : 0;
    const zLen = tile.extraZData ? tile.extraZData.length : 0;

    // Use independent layer dimension trackers when available (they are the ground truth per-layer).
    // Fall back to the shared tileHeader dims only when independent dims haven't been set.
    const imgCx = tile._extraImg_cx || tile.tileHeader.cx_extra || 0;
    const imgCy = tile._extraImg_cy || tile.tileHeader.cy_extra || 0;
    const zCx   = tile._extraZ_cx  || tile.tileHeader.cx_extra || 0;
    const zCy   = tile._extraZ_cy  || tile.tileHeader.cy_extra || 0;
    const imgExpected = imgCx * imgCy;
    const zExpected   = zCx  * zCy;

    // Mismatch: buffer length doesn't match its own declared dimensions
    if (imgLen > 0 && imgExpected > 0 && imgLen !== imgExpected) return true;
    if (zLen   > 0 && zExpected   > 0 && zLen   !== zExpected)   return true;

    // Mismatch: both buffers exist but have different sizes (cross-layer incoherence)
    if (imgLen > 0 && zLen > 0 && imgLen !== zLen) return true;

    return false;
}

export async function deleteSelectedTiles(skipConfirm = false) {
    if (state.tileSelection.size === 0) return;

    const isBond = state.bondSelection;
    const subSelectionSet = state.subSelection;
    
    const indicesToDelete = [];
    const indicesToClearExtra = [];

    state.tileSelection.forEach(idx => {
        if (isBond || subSelectionSet.has(`${idx}_base`)) {
            indicesToDelete.push(idx);
        } else if (subSelectionSet.has(`${idx}_extra`)) {
            indicesToClearExtra.push(idx);
        }
    });

    if (indicesToDelete.length === 0 && indicesToClearExtra.length === 0) return;

    // Safety: don't delete everything
    if (indicesToDelete.length >= state.tiles.length) return;

    // Build items list for confirmation
    const itemsForConfirm = [];
    indicesToDelete.forEach(idx => itemsForConfirm.push({ type: 'cell', idx }));
    indicesToClearExtra.forEach(idx => itemsForConfirm.push({ type: 'extra', idx }));

    // Show specialized confirmation dialog
    if (!skipConfirm) {
        const confirmed = await showDeleteConfirmation(itemsForConfirm);
        if (!confirmed) return;
    }

    pushHistory();

    // 1. Clear extra data for those where ONLY extra was selected
    indicesToClearExtra.forEach(idx => {
        const t = state.tiles[idx];
        if (t && t.tileHeader) {
            t.tileHeader.has_extra_data = false;
            t.tileHeader.cx_extra = 0;
            t.tileHeader.cy_extra = 0;
            t.tileHeader.x_extra = 0;
            t.tileHeader.y_extra = 0;
            t.extraImageData = null;
            t.extraZData = null;
            
            if (state.currentTileKey === `${idx}_extra`) {
                state.currentTileKey = `${idx}_base`;
            }
        }
    });

    // 2. Full Cell Deletion
    const sortedDelete = indicesToDelete.sort((a, b) => b - a);
    for (const idx of sortedDelete) {
        state.tiles.splice(idx, 1);
    }

    // Comprehensive selection reset
    state.tileSelection.clear();
    state.subSelection.clear();
    
    state.currentTileIdx = Math.min(state.tiles.length - 1, state.currentTileIdx);
    
    if (state.currentTileIdx >= 0) {
        state.tileSelection.add(state.currentTileIdx);
        const lastKey = state.currentTileKey;
        if (isBond || !lastKey || lastKey.startsWith(`${state.currentTileIdx}_`)) {
             state.currentTileKey = `${state.currentTileIdx}_base`;
        }
        state.subSelection.add(state.currentTileKey);
    } else {
        state.currentTileKey = null;
    }

    updateTilesList();
    renderCanvas();
    updateMismatchNotification();
}

/**
 * Specialized confirmation for deletions with professional table and previews
 */
export async function showDeleteConfirmation(items) {
    const dialog = document.getElementById('deleteConfirmDialog');
    const listEl = document.getElementById('deleteConfirmList');
    const btnExecute = document.getElementById('btnDeleteConfirmExecute');
    const btnCancel = document.getElementById('btnDeleteConfirmCancel');
    const titleEl = document.getElementById('deleteConfirmTitle');
    
    if (!dialog || !listEl) return confirm("Delete selected items?");

    // Update title based on count
    const total = items.length;
    titleEl.textContent = total > 1 
        ? t('lbl_confirm_deletion_multi').replace('{{total}}', total)
        : t('lbl_confirm_deletion_single');

    listEl.innerHTML = `
        <table style="width:100%; border-collapse:collapse; font-size:13px; font-family: 'Chakra Petch', 'Segoe UI', monospace; color:#e2e8f0; table-layout:fixed;">
            <thead style="background:#000; color:#888; text-transform:uppercase; font-size:10px; position:sticky; top:0; z-index:10; border-bottom: 2px solid #555;">
                <tr>
                    <th style="padding:10px 8px; text-align:left; width:90px;">${t('lbl_tbl_base')}</th>
                    <th style="padding:10px 8px; text-align:left; width:90px;">${t('lbl_tbl_extra')}</th>
                    <th style="padding:10px 8px; text-align:center; width:50px;">${t('lbl_index')}</th>
                    <th style="padding:10px 8px; text-align:center; width:90px;">${t('lbl_tbl_cell_xy')}</th>
                    <th style="padding:10px 8px; text-align:center; width:60px;">${t('lbl_tbl_height')}</th>
                    <th style="padding:10px 8px; text-align:center; width:90px;">${t('lbl_tbl_extra_xy')}</th>
                    <th style="padding:10px 8px; text-align:left;">${t('lbl_tbl_land_type')}</th>
                    <th style="padding:10px 8px; text-align:left;">${t('lbl_tbl_ramp_type')}</th>
                </tr>
            </thead>
            <tbody id="deleteConfirmTBody"></tbody>
        </table>
    `;
    const tbody = document.getElementById('deleteConfirmTBody');

    // Match indices from originalIdx to displayIdx using the same logic as the rest of the UI
    const idxToDisplay = new Map();
    let currentDIdx = 0;
    state.tiles.forEach((t, i) => {
        if (t && t.tileHeader !== null) {
            idxToDisplay.set(i, currentDIdx++);
        }
    });

    items.forEach(item => {
        const tile = state.tiles[item.idx];
        if (!tile) return;
        const h = tile.tileHeader;
        const displayIdx = idxToDisplay.has(item.idx) ? idxToDisplay.get(item.idx) : item.idx;

        const row = document.createElement('tr');
        row.style.borderBottom = '1px solid #1a1a1a';
        row.style.background = 'rgba(255,255,255,0.012)';
        
        // --- Structural HTML ---
        row.innerHTML = `
            <td class="cd-base" style="padding:6px 8px;"></td>
            <td class="cd-extra" style="padding:6px 8px;"></td>
            <td style="padding:8px; text-align:center; color:#fff; font-weight:700; font-size:13px;">${displayIdx}</td>
            <td style="padding:8px; text-align:center; color:#cbd5e0; font-family:monospace;">${h.x}, ${h.y}</td>
            <td style="padding:8px; text-align:center; color:#fff; font-family:monospace;">${h.height}</td>
            <td style="padding:8px; text-align:center; color:#00ffaa; font-family:monospace;">${h.has_extra_data ? `${h.x_extra}, ${h.y_extra}` : '-'}</td>
            <td style="padding:8px; color:#edf2f7; font-size:12px;">${h.land_type} - ${getLandTypeName(h.land_type)}</td>
            <td style="padding:8px; color:#edf2f7; font-size:12px;">${h.ramp_type} - ${getRampTypeName(h.ramp_type)}</td>
        `;

        // Anchor 1: Base Preview
        const tdBase = row.querySelector('.cd-base');
        const c1 = document.createElement('canvas');
        c1.width = 60; c1.height = 30;
        c1.style.width = '64px'; c1.style.height = '32px';
        c1.style.imageRendering = 'pixelated';
        c1.style.background = '#000';
        c1.style.display = 'block';
        // Base border: 1px Neon Green if being deleted, otherwise subtle dark
        c1.style.border = (item.type === 'cell') ? '1px solid var(--accent)' : '1px solid #333';
        renderTileThumbnail(tile, c1.getContext('2d'), 60, 30, false, false, 'base');
        tdBase.appendChild(c1);

        // Anchor 2: Extra Preview
        const tdExtra = row.querySelector('.cd-extra');
        if (h.has_extra_data || item.type === 'extra') {
             const c2 = document.createElement('canvas');
             c2.width = 60; c2.height = 30;
             c2.style.width = '64px'; c2.style.height = '32px';
             c2.style.imageRendering = 'pixelated';
             c2.style.background = '#000';
             c2.style.display = 'block';
             // Extra border: 1px Neon Green if being deleted/cleared, otherwise subtle dark
             c2.style.border = (item.type === 'extra' || item.type === 'cell') ? '1px solid var(--accent)' : '1px solid #333';
             renderTileThumbnail(tile, c2.getContext('2d'), 60, 30, false, false, 'extra');
             tdExtra.appendChild(c2);
        } else {
             tdExtra.innerHTML = '<div style="width:64px; height:32px; display:flex; align-items:center; justify-content:center; color:#333; font-size:9px; border: 1px dashed #222;">-</div>';
        }

        tbody.appendChild(row);
    });

    return new Promise((resolve) => {
        const cleanup = (val) => {
            btnExecute.onclick = null;
            btnCancel.onclick = null;
            dialog.close();
            resolve(val);
        };
        btnExecute.onclick = () => cleanup(true);
        btnCancel.onclick = () => cleanup(false);
        dialog.showModal();
    });
}

/**
 * Helper to generate a canvas and indexed data from the current selection or whole project
 */
export async function generateExportDataFromSelection(mode) {
    try {
        const isTotal = mode.includes('total');
        const isZMode = mode.includes('z') || mode.includes('_z_');
        const sorted = Array.from(state.tileSelection).sort((a, b) => a - b);
        
        if (state.tileSelection.size === 0 && !isTotal) return null;

        const baseW = state.gameType === 'ts' ? 48 : 60;
        const baseH = state.gameType === 'ts' ? 24 : 30;

        let minX = Infinity, minY = Infinity;
        let maxX = -Infinity, maxY = -Infinity;
        let workSet = [];

        if (isTotal) {
            workSet = state.tiles.map((_, i) => i).filter(idx => state.tiles[idx] && state.tiles[idx].tileHeader);
        } else {
            workSet = sorted.filter(idx => state.tiles[idx] && state.tiles[idx].tileHeader);
        }

        const halfCy = state.cy / 2;
        for (const idx of workSet) {
            const t = state.tiles[idx];
            const elevation = state.flatCells ? 0 : t.tileHeader.height * halfCy;
            const includeBase = mode.includes('merged') || mode.includes('cell') || isTotal;
            const includeExtra = mode.includes('merged') || mode.includes('extra') || isTotal;

            if (includeBase) {
                minX = Math.min(minX, t.tileHeader.x);
                minY = Math.min(minY, t.tileHeader.y - elevation);
                maxX = Math.max(maxX, t.tileHeader.x + baseW);
                maxY = Math.max(maxY, t.tileHeader.y - elevation + baseH);
            }
            if (includeExtra && t.tileHeader.has_extra_data) {
                const drawImg = mode === 'img_extra' || mode === 'img_merged' || mode === 'img_total' || mode === 'place_extra' || mode === 'place_merged' || mode === 'place_total' || mode === 'only_extra' || mode === 'full';
                const drawZ = mode === 'z_extra' || mode === 'z_merged' || mode === 'z_total' || mode === 'only_extra' || mode === 'full';

                let ew = 0, eh = 0;
                if (drawImg && t.extraImageData) {
                    ew = Math.max(ew, t._extraImg_cx || t.tileHeader.cx_extra || 0);
                    eh = Math.max(eh, t._extraImg_cy || t.tileHeader.cy_extra || 0);
                }
                if (drawZ && t.extraZData) {
                    ew = Math.max(ew, t._extraZ_cx || t.tileHeader.cx_extra || 0);
                    eh = Math.max(eh, t._extraZ_cy || t.tileHeader.cy_extra || 0);
                }

                // Fallback to shared header if no buffers exist but data is flagged
                if (ew === 0 && eh === 0) {
                    ew = t.tileHeader.cx_extra;
                    eh = t.tileHeader.cy_extra;
                }

                minX = Math.min(minX, t.tileHeader.x_extra);
                minY = Math.min(minY, t.tileHeader.y_extra - elevation);
                maxX = Math.max(maxX, t.tileHeader.x_extra + ew);
                maxY = Math.max(maxY, t.tileHeader.y_extra - elevation + eh);
            }
        }

        const totalW = (minX === Infinity) ? 0 : maxX - minX;
        const totalH = (minY === Infinity) ? 0 : maxY - minY;

        if (minX === Infinity || totalW <= 0 || totalH <= 0) {
            showPasteNotification(t('msg_no_tiles_export'), 'error');
            return null;
        }

        const canvas = document.createElement('canvas');
        canvas.width = totalW;
        canvas.height = totalH;
        const ctx = canvas.getContext('2d');
        const indexedIndices = new Uint8Array(totalW * totalH).fill(255);

        const currentPalette = state.activePalette || (state.palettes && state.palettes[0] ? state.palettes[0].data : null) || state.palette;
        if (!currentPalette && !isZMode) {
            showPasteNotification(t('msg_no_pal_export'), 'error');
            return null;
        }

        const palLUT = new Uint32Array(256);
        if (currentPalette) {
            for (let i = 0; i < 256; i++) {
                const c = currentPalette[i] || { r: 0, g: 0, b: 0 };
                palLUT[i] = (255 << 24) | (c.b << 16) | (c.g << 8) | c.r;
            }
        }

        const zLUT = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            if (i < 32) {
                const gray = Math.round((i * 255) / 31);
                zLUT[i] = (255 << 24) | (gray << 16) | (gray << 8) | gray;
            } else {
                zLUT[i] = (255 << 24) | (0 << 16) | (0 << 8) | 255;
            }
        }

        const zValidMask = isZMode ? new Uint8Array(totalW * totalH) : null;

        const isPlace = mode.includes('place_');
        const bgIdx = state.preferences ? parseInt(state.preferences.bgColor) || 0 : 0;
        let whiteIdx = 255;
        if (isPlace && currentPalette) {
            let minDist = Infinity;
            for (let i = 1; i < 256; i++) {
                const c = currentPalette[i] || {r:0, g:0, b:0};
                const dist = (255 - c.r)**2 + (255 - c.g)**2 + (255 - c.b)**2;
                if (dist < minDist) {
                    minDist = dist;
                    whiteIdx = i;
                }
            }
        }

        const drawLayer = (buffer, lx, ly, bw, bh, isZ, isBase) => {
            if (!buffer && !isPlace) return;
            const temp = document.createElement('canvas');
            temp.width = bw;
            temp.height = bh;
            const tempCtx = temp.getContext('2d');
            const imgData = tempCtx.createImageData(bw, bh);
            const d32 = new Uint32Array(imgData.data.buffer);
            const lut = isZ ? zLUT : palLUT;

            const startX = Math.round(lx - minX);
            const startY = Math.round(ly - minY);
            
            // Loop over every pixel in the tile's bounding box
            const area = bw * bh;
            for (let i = 0; i < area; i++) {
                const localX = i % bw;
                const localY = Math.floor(i / bw);
                
                // Base value: actual data OR placeholder background
                let px = (buffer && i < buffer.length) ? buffer[i] : (isZ ? 0 : bgIdx);
                
                // Overlay placeholder grid
                if (isPlace) {
                    px = isZ ? 0 : bgIdx; // Reset to background first for pure placeholder
                    if (isBase) {
                        if (TmpTsFile.isInsideWestwoodDiamond(localX, localY, bw, bh)) {
                            const N = TmpTsFile.isInsideWestwoodDiamond(localX, localY - 1, bw, bh);
                            const S = TmpTsFile.isInsideWestwoodDiamond(localX, localY + 1, bw, bh);
                            const E = TmpTsFile.isInsideWestwoodDiamond(localX + 1, localY, bw, bh);
                            const W = TmpTsFile.isInsideWestwoodDiamond(localX - 1, localY, bw, bh);
                            if (!N || !S || !E || !W) px = isZ ? 31 : whiteIdx;
                        } else {
                            continue; // Skip drawing outside diamond for base layer
                        }
                    } else {
                        // Extra Data Bounding Box
                        if (localX === 0 || localX === bw - 1 || localY === 0 || localY === bh - 1) {
                            px = isZ ? 31 : whiteIdx;
                        }
                    }
                } else {
                    // Regular copy: skip transparent or garbage pixels
                    if (isZ) {
                        if (px >= 32) continue; // Z-Data is 0-31. 255 is transparent. 32-254 is garbage.
                        if (!isBase && px === 0) continue; // Extra Data treats 0 as void
                    } else {
                        if (px === 0) continue; 
                    }
                }

                d32[i] = lut[px & 0xFF];
                
                const destX = startX + localX;
                const destY = startY + localY;
                const destIdx = destY * totalW + destX;
                if (destX >= 0 && destX < totalW && destY >= 0 && destY < totalH) {
                    indexedIndices[destIdx] = px;
                    if (isZ && px < 32 && zValidMask) zValidMask[destIdx] = 1;
                }
            }
            tempCtx.putImageData(imgData, 0, 0);
            ctx.drawImage(temp, startX, startY);
        };

        workSet.sort((a, b) => parseInt(a) - parseInt(b));

        for (const idx of workSet) {
            const t = state.tiles[idx];
            const elevation = state.flatCells ? 0 : t.tileHeader.height * halfCy;
            
            const drawBaseImg = mode === 'img_cell' || mode === 'img_merged' || mode === 'img_total' || mode === 'place_cell' || mode === 'place_merged' || mode === 'place_total';
            const drawBaseZ = mode === 'z_cell' || mode === 'z_merged' || mode === 'z_total';

            if (drawBaseImg) {
                drawLayer(t.data, t.tileHeader.x, t.tileHeader.y - elevation, baseW, baseH, false, true);
            }
            if (drawBaseZ) {
                drawLayer(t.zData, t.tileHeader.x, t.tileHeader.y - elevation, baseW, baseH, true, true);
            }

            if (t.tileHeader.has_extra_data) {
                const drawExtraImg = mode === 'img_extra' || mode === 'img_merged' || mode === 'img_total' || mode === 'place_extra' || mode === 'place_merged' || mode === 'place_total';
                const drawExtraZ = mode === 'z_extra' || mode === 'z_merged' || mode === 'z_total';

                if (drawExtraImg && t.extraImageData) {
                    const eCx = t._extraImg_cx || t.tileHeader.cx_extra;
                    const eCy = t._extraImg_cy || t.tileHeader.cy_extra;
                    drawLayer(t.extraImageData, t.tileHeader.x_extra, t.tileHeader.y_extra - elevation, eCx, eCy, false, false);
                }
                if (drawExtraZ && t.extraZData) {
                    const zCx = t._extraZ_cx || t.tileHeader.cx_extra;
                    const zCy = t._extraZ_cy || t.tileHeader.cy_extra;
                    drawLayer(t.extraZData, t.tileHeader.x_extra, t.tileHeader.y_extra - elevation, zCx, zCy, true, false);
                }
            }
        }

        if (isZMode) {
            ctx.globalCompositeOperation = 'destination-over';
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, totalW, totalH);
            ctx.globalCompositeOperation = 'source-over';
        } else if (state.showBackground) {
            const bg = (currentPalette && currentPalette[0]) || { r: 0, g: 0, b: 255 };
            ctx.globalCompositeOperation = 'destination-over';
            ctx.fillStyle = `rgb(${bg.r},${bg.g},${bg.b})`;
            ctx.fillRect(0, 0, totalW, totalH);
            ctx.globalCompositeOperation = 'source-over';
        }

        return { canvas, indices: indexedIndices, width: totalW, height: totalH };
    } catch (err) {
        console.error("Export data generation failed:", err);
        showPasteNotification(t('msg_err_export').replace('{{error}}', err.message), 'error');
        return null;
    }
}

/**
 * Legacy wrapper for internal calls
 */
export async function generateImageFromSelection(mode) {
    const data = await generateExportDataFromSelection(mode);
    return data ? data.canvas : null;
}

/**
 * Advanced Copy functionality supporting various modes (Data, Image, Z-Mask)
 */
export async function copySelectedTiles(mode = 'full') {
    const isTotal = mode.includes('total');
    if (state.tileSelection.size === 0 && !isTotal) return;
    const sorted = Array.from(state.tileSelection).sort((a, b) => a - b);
    
    // 1. Data Mode (Internal Clipboard) - ALWAYS POPULATE FOR NON-TOTAL
    if (!isTotal) {
        const tilesToCopy = sorted.map(i => {
            const t = state.tiles[i];
            if (!t) return null;
            const copy = { 
                ...t, 
                id: generateId(),
                baseX: t.tileHeader ? t.tileHeader.x : 0,
                baseY: t.tileHeader ? t.tileHeader.y : 0
            };
            
            if (mode === 'only_cell') {
                copy.extraImageData = null; copy.extraZData = null;
            } else if (mode === 'only_extra') {
                copy.data = null; copy.zData = null;
            } else if (mode === 'img_merged') {
                copy.zData = null; copy.extraZData = null;
            } else if (mode === 'img_cell') {
                copy.zData = null; copy.extraImageData = null; copy.extraZData = null;
            } else if (mode === 'img_extra') {
                copy.data = null; copy.zData = null; copy.extraZData = null;
            } else if (mode === 'z_merged') {
                copy.data = null; copy.extraImageData = null;
            } else if (mode === 'z_cell') {
                copy.data = null; copy.extraImageData = null; copy.extraZData = null;
            } else if (mode === 'z_extra') {
                copy.data = null; copy.zData = null; copy.extraImageData = null;
            }
            if (copy.data) copy.data = new Uint8Array(copy.data);
            if (copy.zData) copy.zData = new Uint8Array(copy.zData);
            if (copy.extraImageData) copy.extraImageData = new Uint8Array(copy.extraImageData);
            if (copy.extraZData) copy.extraZData = new Uint8Array(copy.extraZData);
            if (copy.damagedData) copy.damagedData = new Uint8Array(copy.damagedData);
            if (copy.tileHeader) copy.tileHeader = { ...copy.tileHeader };

            if (mode.includes('place_')) {
                const bgIdx = state.preferences ? parseInt(state.preferences.bgColor) || 0 : 0;
                let whiteIdx = 255;
                const pal = state.activePalette || (state.palettes && state.palettes[0] ? state.palettes[0].data : null) || state.palette;
                if (pal) {
                    let minDist = Infinity;
                    for (let x = 1; x < 256; x++) {
                        const c = pal[x] || {r:0,g:0,b:0};
                        const dist = (255-c.r)**2 + (255-c.g)**2 + (255-c.b)**2;
                        if (dist < minDist) { minDist = dist; whiteIdx = x; }
                    }
                }
                const baseW = state.gameType === 'ts' ? 48 : 60;
                const baseH = state.gameType === 'ts' ? 24 : 30;

                if (copy.data) {
                    for (let i=0; i<copy.data.length; i++) {
                        const lx = i % baseW, ly = Math.floor(i / baseW);
                        if (!TmpTsFile.isInsideWestwoodDiamond(lx, ly, baseW, baseH)) { 
                            copy.data[i]=0; 
                            if (copy.zData) copy.zData[i]=0;
                            continue; 
                        }
                        const N = TmpTsFile.isInsideWestwoodDiamond(lx, ly-1, baseW, baseH);
                        const S = TmpTsFile.isInsideWestwoodDiamond(lx, ly+1, baseW, baseH);
                        const E = TmpTsFile.isInsideWestwoodDiamond(lx+1, ly, baseW, baseH);
                        const W = TmpTsFile.isInsideWestwoodDiamond(lx-1, ly, baseW, baseH);
                        const isBorder = (!N || !S || !E || !W);
                        copy.data[i] = isBorder ? whiteIdx : bgIdx;
                        if (copy.zData) copy.zData[i] = isBorder ? 31 : 0;
                    }
                }
                if (copy.extraImageData && copy.tileHeader.has_extra_data) {
                    const ew = copy.tileHeader.cx_extra, eh = copy.tileHeader.cy_extra;
                    for (let i=0; i<copy.extraImageData.length; i++) {
                        const lx = i % ew, ly = Math.floor(i / ew);
                        const isBorder = (lx===0 || lx===ew-1 || ly===0 || ly===eh-1);
                        copy.extraImageData[i] = isBorder ? whiteIdx : bgIdx;
                        if (copy.extraZData) copy.extraZData[i] = isBorder ? 31 : 0;
                    }
                }
            }
            
            return copy;
        }).filter(t => t !== null);

        state.tileClipboard = tilesToCopy;
        state.tileClipboardMetadata = {
            mode,
            count: tilesToCopy.length,
            gameType: state.gameType,
            v: Date.now()
        };

        console.warn(`[DEBUG OMEGA] --- COPY TRIGGERED ---`);
        console.log(`[DEBUG OMEGA] Mode: ${mode}, Tiles Copied: ${tilesToCopy.length}`);
        tilesToCopy.forEach((t, index) => {
            console.log(`  Index ${index}: baseH=${t.tileHeader?.height}, data=${t.data?.length||0}, zData=${t.zData?.length||0}`);
            console.log(`    Extra: cx=${t.tileHeader?.cx_extra}, cy=${t.tileHeader?.cy_extra}`);
            console.log(`    Extra Buffers: Img=${t.extraImageData?.length||0} (dims: ${t._extraImg_cx}x${t._extraImg_cy}), Z=${t.extraZData?.length||0} (dims: ${t._extraZ_cx}x${t._extraZ_cy})`);
        });
        console.warn(`[DEBUG OMEGA] ----------------------`);

        try {
            const serializable = tilesToCopy.map(t => ({
                ...t,
                data: t.data ? Array.from(t.data) : null,
                zData: t.zData ? Array.from(t.zData) : null,
                extraImageData: t.extraImageData ? Array.from(t.extraImageData) : null,
                extraZData: t.extraZData ? Array.from(t.extraZData) : null,
                damagedData: t.damagedData ? Array.from(t.damagedData) : null
            }));
            const json = JSON.stringify({
                type: 'tmp_tiles',
                tiles: serializable,
                metadata: state.tileClipboardMetadata,
                v: Date.now()
            });
            localStorage.setItem('tmp_tile_clipboard', json);
            localStorage.setItem('tmp_clipboard_type', 'tiles');
            state.internalClipboard = { type: 'tiles', data: JSON.parse(json) };

            const validInternalModes = ['full', 'only_cell', 'only_extra', 'img_merged', 'img_cell', 'img_extra', 'z_merged', 'z_cell', 'z_extra', 'place_merged'];
            if (validInternalModes.includes(mode)) {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText('__TMP_TILES_DATA__').catch(() => {});
                }
            }

            updateUIState();
        } catch (e) {
            console.warn("Failed to sync clipboard:", e);
        }
    } 
    // 2. Image and Z-Mask Modes (Copy to System Clipboard)
    if (!['full', 'only_cell', 'only_extra'].includes(mode)) {
        try {
            const canvas = await generateImageFromSelection(mode);
            if (!canvas) return;

            const isFileProtocol = window.location.protocol === 'file:';

            canvas.toBlob(async (blob) => {
                if (blob && navigator.clipboard && navigator.clipboard.write) {
                    try {
                        const items = { 'image/png': blob };
                        if (!isTotal) {
                            items['text/html'] = new Blob(['<meta name="tmp_clipboard" content="__TMP_TILES_DATA__">'], { type: 'text/html' });
                        }
                        await navigator.clipboard.write([
                            new ClipboardItem(items)
                        ]);
                        console.log(`[Clipboard] Successfully copied ${mode} (${canvas.width}x${canvas.height}) to system clipboard.`);
                    } catch (err) {
                        console.error("Clipboard write failed:", err);
                        if (isFileProtocol) showImageCopyFallback(canvas.toDataURL(), mode);
                        else showPasteNotification(t('clipboard_error') + ": " + err.name, 'error');
                    }
                } else {
                    if (isFileProtocol) showImageCopyFallback(canvas.toDataURL(), mode);
                    else showPasteNotification(t('clipboard_blocked'), 'error');
                }
            });

        } catch (err) {
            console.error("Copy failed:", err);
            showPasteNotification(`Copy Error: ${err.message}`, 'error');
        }
    }
}

/**
 * Saves the selected tiles or whole project to a file
 */
export async function saveSelectedTilesToFile(mode) {
    try {
        const data = await generateExportDataFromSelection(mode);
        if (!data) return;

        const isZ = mode.includes('z');
        const defaultName = isZ ? "z_mask.png" : "image.png";

        // Modern File System Access API
        if (window.showSaveFilePicker) {
            try {
                const handle = await window.showSaveFilePicker({
                    suggestedName: defaultName,
                    types: [
                        { description: 'PNG Image', accept: { 'image/png': ['.png'] } },
                        { description: 'PCX Image', accept: { 'image/x-pcx': ['.pcx'] } },
                        { description: 'JPEG Image', accept: { 'image/jpeg': ['.jpg'] } },
                        { description: 'BMP Image', accept: { 'image/bmp': ['.bmp'] } }
                    ]
                });
                
                const writable = await handle.createWritable();
                const filename = handle.name.toLowerCase();
                
                if (filename.endsWith('.pcx')) {
                    const currentPalette = state.activePalette || (state.palettes && state.palettes[0] ? state.palettes[0].data : null) || state.palette;
                    const pcxBuffer = PcxLoader.encode(data.width, data.height, data.indices, currentPalette);
                    await writable.write(new Blob([pcxBuffer], { type: 'image/x-pcx' }));
                } else {
                    const fileType = filename.endsWith('.jpg') ? 'image/jpeg' : 
                                   filename.endsWith('.bmp') ? 'image/bmp' : 'image/png';
                    const blob = await new Promise(resolve => data.canvas.toBlob(resolve, fileType));
                    await writable.write(blob);
                }
                
                await writable.close();
                console.log(`Saved ${mode} to file ${handle.name}`);
            } catch (err) {
                if (err.name !== 'AbortError') {
                    console.error("Save File Picker failed:", err);
                    throw err;
                }
            }
        } else {
            // Fallback for Firefox/Safari: Browser Download
            const link = document.createElement('a');
            link.download = defaultName;
            link.href = data.canvas.toDataURL('image/png');
            link.click();
        }
    } catch (err) {
        console.error("Save failed:", err);
        showPasteNotification(t('msg_err_export').replace('{{error}}', err.message), 'error');
    }
}

/**
 * Shows a modal with the generated image for manual 'Right-Click -> Copy' in file:// contexts.
 */
function showImageCopyFallback(dataUrl, mode) {
    const dlg = document.getElementById('promptModal');
    const title = document.getElementById('promptTitle');
    const msg = document.getElementById('promptMessage');
    const inp = document.getElementById('promptInput');
    const ok = document.getElementById('btnPromptOk');
    const cancel = document.getElementById('btnPromptCancel');

    if (!dlg || !title || !msg || !inp) {
        alert(t('msg_offline_cb_manual'));
        return;
    }

    title.textContent = t('lbl_offline_cb_bridge');
    msg.innerHTML = `<b>Local File Detected:</b> Browser security blocks direct clipboard access.<br><br>Please <b>Right-click</b> the image below and select <b>'Copy Image'</b>:<br><br>
    <div style="text-align:center; padding: 10px; background: #000; border: 1px solid #444; border-radius: 4px;">
        <img src="${dataUrl}" style="max-width: 100%; border: 1px dashed #666; cursor: context-menu;" alt="Generated Image">
    </div>`;
    
    inp.style.display = 'none';
    ok.textContent = t('lbl_done');
    
    ok.onclick = () => {
        inp.style.display = 'block';
        dlg.close();
    };
    cancel.onclick = () => {
        inp.style.display = 'block';
        dlg.close();
    };

    dlg.showModal();
}

/** Internal helper for direct buffer rendering */
function _drawBufferToCtx(ctx, buffer, x, y, w, h, palette) {
    const imgData = ctx.createImageData(w, h);
    for (let i = 0; i < buffer.length; i++) {
        const idx = buffer[i];
        const offset = i * 4;
        if (idx === 0) {
            imgData.data[offset+3] = 0;
            continue;
        }
        const col = palette[idx] || {r:255, g:0, b:255};
        imgData.data[offset] = col.r;
        imgData.data[offset+1] = col.g;
        imgData.data[offset+2] = col.b;
        imgData.data[offset+3] = 255;
    }
    ctx.putImageData(imgData, x, y);
}

export function cutSelectedTiles() {
    copySelectedTiles();
    deleteSelectedTiles(true);
}

/**
 * Shows the dark red notification bar with a message
 */
export function showPasteNotification(msg) {
    const el = document.getElementById('pasteNotification');
    const msgEl = document.getElementById('pasteNotificationMsg');
    if (el && msgEl) {
        msgEl.textContent = msg;
        el.classList.add('active');
    }
}

/**
 * Advanced Paste functionality supporting internal (Data) and system (Image) clipboards.
 * @param {boolean} isForced - If true, replaces selected tiles. If false, appends to the list.
 * @param {string} mode - Mode: 'full', 'only_cell', 'only_extra', 'img_merged', 'img_cell', 'img_extra', 'z_cell', 'z_extra'
 * @param {boolean} forceInternalRouting - If true, forces routing to internal clipboard swap regardless of mode string.
 */
export async function pasteTiles(isForced = false, mode = 'full', forceInternalRouting = false) {
    console.log(`[Paste:Flow] Triggered. Type: ${mode}, Forced: ${isForced}, Selection: ${state.tileSelection?.size}, ForceInternal: ${forceInternalRouting}`);

    // Treat "Paste" as "Paste Into" if we have an active selection and we are in Image/Z Modes
    if (!isForced && state.tileSelection?.size > 0 && (mode.includes('img') || mode.includes('z'))) {
        isForced = true;
    }

    // Force thumbnail cache bust after any paste operation to solve stale UI thumbnails
    state.paletteVersion++;
    if (typeof _layerThumbCache !== 'undefined' && _layerThumbCache.clear) {
        _layerThumbCache.clear();
    }
    // Sync from cross-tab if local is empty to determine source mode
    if (!state.tileClipboard || state.tileClipboard.length === 0) {
        try {
            const raw = localStorage.getItem('tmp_tile_clipboard');
            if (raw) {
                const bundle = JSON.parse(raw);
                if (bundle.type === 'tmp_tiles' && Array.isArray(bundle.tiles)) {
                    state.tileClipboard = bundle.tiles.map(t => ({
                        ...t,
                        data: t.data ? new Uint8Array(t.data) : null,
                        zData: t.zData ? new Uint8Array(t.zData) : null,
                        extraImageData: t.extraImageData ? new Uint8Array(t.extraImageData) : null,
                        extraZData: t.extraZData ? new Uint8Array(t.extraZData) : null,
                        damagedData: t.damagedData ? new Uint8Array(t.damagedData) : null,
                        tileHeader: t.tileHeader ? { ...t.tileHeader } : null
                    }));
                    state.tileClipboardMetadata = bundle.metadata;
                }
            }
        } catch (e) { }
    }

    // CROSS-LAYER DETECTION: If source clipboard mode (z vs img) doesn't match the paste target mode,
    // fall back to the system clipboard path. The copy operation already generated a visual PNG
    // (grayscale for Z-data, indexed-color for Image) and stored it in the system clipboard.
    // Using that PNG through _pasteFromImageBuffer gives the correct visual result automatically.
    // Internal routing is ONLY for same-type pastes (img→img, z→z) to fix the "extra data bleeding" bug.
    if (forceInternalRouting && !mode.includes('_to_') && state.tileClipboardMetadata?.mode) {
        const srcMode = state.tileClipboardMetadata.mode;
        const isSrcZ = srcMode.includes('z_');
        const isTrgImg = mode.includes('img_');
        const isSrcImg = srcMode.includes('img_');
        const isTrgZ = mode.includes('z_');
        
        if ((isSrcZ && isTrgImg) || (isSrcImg && isTrgZ)) {
            console.warn(`[Paste:Flow] Cross-layer detected (Source: ${srcMode}, Target: ${mode}). Using System Clipboard PNG (generated by copy operation) instead of internal conversion.`);
            forceInternalRouting = false;
        }
    }

    // 1. Data Mode (Internal Clipboard)
    if (forceInternalRouting || mode === 'full' || mode.includes('only_') || mode.includes('place_') || mode.includes('_to_')) {
        console.log(`  - Branch: INTERNAL CLIPBOARD Path.`);

        if (!state.tileClipboard || state.tileClipboard.length === 0) {
            showPasteNotification(t('msg_internal_cb_empty'));
            return;
        }

        // Cross-game check
        if (state.tileClipboardMetadata?.gameType && state.tileClipboardMetadata.gameType !== state.gameType) {
            showPasteNotification(t('msg_cross_game_paste_blocked').replace('{{details}}', `${state.tileClipboardMetadata.gameType.toUpperCase()} -> ${state.gameType.toUpperCase()}`));
            return;
        }

        // Logic routing
        console.warn(`[DEBUG OMEGA] --- PASTE DECISION ROUTING ---`);
        console.log(`[DEBUG OMEGA] mode: ${mode}, isForced: ${isForced}, selection_size: ${state.tileSelection.size}`);
        
        if (isForced) {
            if (state.tileSelection.size === 0) {
                showPasteNotification(t('msg_no_tiles_forced'));
                return;
            }
            // For Advanced modes within Forced Paste (Only Cell, Only Extra), we need a custom handler.
            if (mode === 'full' || mode === 'place_merged') {
                console.log(`[DEBUG OMEGA] Routing to: pasteIntoSelectedTiles()`);
                pasteIntoSelectedTiles();
            } else {
                console.log(`[DEBUG OMEGA] Routing to: _pastePartialDataIntoSelectedTiles(${mode})`);
                _pastePartialDataIntoSelectedTiles(mode);
            }
        } else {
            console.log(`[DEBUG OMEGA] Routing to: pasteTilesAtEnd(${mode})`);
            // Append with potential mode masking
            pasteTilesAtEnd(mode);
        }
    } 
    // 2. Image/Z-Mask Mode (System Clipboard)
    else {
        console.log(`  - Routing: SYSTEM CLIPBOARD (Image) Path.`);
        console.warn(`[DEBUG OMEGA] --- PASTE DECISION ROUTING SYSTEM CLIPBOARD ---`);
        try {
            // Check fallback for Firefox/Chrome blocking clipboard read without explicit interaction
            const items = await navigator.clipboard.read();
            let imgBlob = null;
            for (const item of items) {
                for (const type of item.types) {
                    if (type.startsWith('image/')) {
                        imgBlob = await item.getType(type);
                        break;
                    }
                }
                if (imgBlob) break;
            }

            if (!imgBlob) {
                console.warn("Navigator API found no image. Deploying interceptor fallback.");
                window.pendingSystemPaste = { mode, isForced };
                showPasteNotification(t('msg_paste_warning_ctrlv'), "warning", 4000);
                return;
            }

            // Route to processing
            if (window.processSystemImagePaste) {
                window.processSystemImagePaste(imgBlob, mode, isForced);
            }

        } catch (err) {
            console.warn("Clipboard API blocked, deploying Ctrl+V interceptor.");
            window.pendingSystemPaste = { mode, isForced };
            showPasteNotification(t('msg_paste_blocked_ctrlv'), "warning", 4000);
        }
    }
}

export async function processSystemImagePaste(input, mode, isForced) {
    console.log(`[Paste:System] Processing input. Mode: ${mode}, Forced: ${isForced}`);
    try {
        let imgData = null;
        if (input instanceof ImageData) {
            console.log(`  - Received raw ImageData object.`);
            imgData = input;
        } else {
            console.log(`  - Received Blob/File object. Decoding...`);
            const img = new Image();
            img.src = URL.createObjectURL(input);
            await img.decode();
            console.log(`  - Image Decoded: ${img.width}x${img.height}`);

            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        }

        const width = imgData.width;
        const height = imgData.height;

        // Dimension Safety Checks
        if (mode.includes('cell')) {
            const requiredW = state.gameType === 'ts' ? 48 : 60;
            const requiredH = state.gameType === 'ts' ? 24 : 30;
            if (width !== requiredW || height !== requiredH) {
                showPasteNotification(t('msg_err_paste_dims')
                    .replace('{{width}}', width).replace('{{height}}', height)
                    .replace('{{reqW}}', requiredW).replace('{{reqH}}', requiredH));
                return;
            }
        }

        // Perform Paste from Image
        _pasteFromImageBuffer(imgData, mode, isForced);
    } catch (err) {
        console.error("Paste processing failed:", err);
        showPasteNotification(t('msg_err_paste_failed'), "error");
    }
}
window.processSystemImagePaste = processSystemImagePaste;

/** Helper for partial data overwriting (Only Cell, Only Extra) */
function _pastePartialDataIntoSelectedTiles(mode) {
    if (!state.tileClipboard || state.tileClipboard.length === 0) return;
    pushHistory();
    const sortedTarget = Array.from(state.tileSelection).sort((a, b) => a - b);
    
    sortedTarget.forEach((targetIdx, i) => {
        const sourceIdx = i % state.tileClipboard.length;
        const source = state.tileClipboard[sourceIdx];
        const target = state.tiles[targetIdx];
        if (mode.includes('cell') || mode.includes('merged') || mode.includes('_to_')) {
            if (mode === 'z_to_img' && source.zData) {
                const newImg = new Uint8Array(source.zData.length);
                for(let j=0; j<source.zData.length; j++) {
                    const zVal = source.zData[j];
                    if (zVal !== 255) {
                        const g = Math.min(255, (zVal / 31) * 255);
                        newImg[j] = _findClosestPaletteIndex(g, g, g, state.palette);
                    }
                }
                _mergeBuffers(target.data, newImg);
            }
            else if (mode === 'img_to_z' && source.data) {
                const newZ = new Uint8Array(source.data.length).fill(255);
                for(let j=0; j<source.data.length; j++) {
                    const pIdx = source.data[j];
                    if (pIdx !== 0 && state.palette[pIdx]) {
                        const c = state.palette[pIdx];
                        const brightness = (c.r + c.g + c.b) / 3;
                        newZ[j] = Math.max(1, Math.min(31, Math.round(brightness * 31 / 255)));
                    }
                }
                _mergeBuffers(target.zData, newZ, true);
            }
            else {
                if (source.data && mode !== 'z_cell' && mode !== 'z_merged' && !mode.includes('_to_')) _mergeBuffers(target.data, source.data);
                if (source.zData && mode !== 'img_cell' && mode !== 'img_merged' && !mode.includes('_to_')) _mergeBuffers(target.zData, source.zData, true);
            }
        }

        if (mode.includes('extra') || mode.includes('merged') || mode.includes('_to_')) {
            const sHeader = source.tileHeader;
            if (sHeader && (sHeader.has_extra_data || source.extraImageData || source.extraZData)) {
                if (!target.tileHeader) target.tileHeader = { has_extra_data: 0, x_extra: 0, y_extra: 0, cx_extra: 0, cy_extra: 0, x: 0, y: 0 };
                const tHeader = target.tileHeader;

                // PHILOSOPHY: Derive dimensions from the ACTUAL BUFFER being transferred.
                // Never trust sHeader.cx_extra blindly — it's a shared field and may point
                // to the OTHER layer's resize. Use independent dims as the source of truth.

                // Helper: get verified dims for a buffer using independent dims, falling back to shared header
                const verifyDims = (buf, indCx, indCy, fallbackCx, fallbackCy) => {
                    if (buf && indCx && indCy && buf.length >= indCx * indCy) return [indCx, indCy];
                    if (buf && fallbackCx && fallbackCy && buf.length >= fallbackCx * fallbackCy) return [fallbackCx, fallbackCy];
                    // Last resort: if buffer exists, store without dims (will be inferred later)
                    return [fallbackCx || 0, fallbackCy || 0];
                };

                // Bake existing untouched target dimensions before we overwrite the header!
                if (target.extraImageData && !target._extraImg_cx) {
                    target._extraImg_cx = tHeader.cx_extra || 0;
                    target._extraImg_cy = tHeader.cy_extra || 0;
                }
                if (target.extraZData && !target._extraZ_cx) {
                    target._extraZ_cx = tHeader.cx_extra || 0;
                    target._extraZ_cy = tHeader.cy_extra || 0;
                }

                // Compute true dims for each source layer independently
                const [imgCx, imgCy] = verifyDims(source.extraImageData, source._extraImg_cx, source._extraImg_cy, sHeader.cx_extra, sHeader.cy_extra);
                const [zCx, zCy]   = verifyDims(source.extraZData, source._extraZ_cx, source._extraZ_cy, sHeader.cx_extra, sHeader.cy_extra);

                console.warn(`[DEBUG COPY/PASTE] --- INTERNAL MERGE (${mode}) ---`);
                console.log(`[DEBUG COPY/PASTE] Target BEFORE: tHeader.cx_extra = ${tHeader.cx_extra}, _extraZ_cx = ${target._extraZ_cx}, zData.length = ${target.extraZData ? target.extraZData.length : 0}, _extraImg_cx = ${target._extraImg_cx}, imgData.length = ${target.extraImageData ? target.extraImageData.length : 0}`);
                console.log(`[DEBUG COPY/PASTE] Source COMPUTED: imgCx = ${imgCx}, zCx = ${zCx}`);

                // 1. DATA TRANSFER (Select Correct Source -> Destination)
                // For each transfer, use the BUFFER BEING COPIED as the dimensions, not the other layer's dims.
                if (mode === 'z_to_img') {
                    if (source.extraZData) {
                        const srcArrW = source._extraZ_cx && source.extraZData.length >= source._extraZ_cx * source._extraZ_cy ? source._extraZ_cx : sHeader.cx_extra;
                        const newImg = new Uint8Array(zCx * zCy); // default 0 = transparent
                        let nonTransparentCount = 0;
                        for (let y = 0; y < zCy; y++) {
                            for (let x = 0; x < zCx; x++) {
                                const srcIdx = y * srcArrW + x;
                                const trgIdx = y * zCx + x;
                                const zVal = srcIdx < source.extraZData.length ? source.extraZData[srcIdx] : 255;
                                if (zVal !== 255) {
                                    // Valid Z value: map to gray then find closest palette color (skipping index 0)
                                    const grayVal = Math.min(255, Math.round((zVal / 31) * 255));
                                    newImg[trgIdx] = _findClosestPaletteIndex(grayVal, grayVal, grayVal, state.palette);
                                    nonTransparentCount++;
                                }
                                // else: Z=255 (transparent) → newImg stays 0 (transparent image)
                            }
                        }
                        console.log(`[z_to_img extra] zCx=${zCx}, zCy=${zCy}, totalPx=${zCx*zCy}, nonTransparent=${nonTransparentCount}, sample Z[0..5]=${Array.from(source.extraZData.slice(0, 6))}`);
                        // Only assign if we actually got any real pixels
                        if (nonTransparentCount > 0 || target.extraImageData) {
                            target.extraImageData = newImg;
                            target._extraImg_cx = zCx; target._extraImg_cy = zCy;
                        }
                    }
                } else if (mode === 'img_to_z') {
                    if (source.extraImageData) {
                        const srcArrW = source._extraImg_cx && source.extraImageData.length >= source._extraImg_cx * source._extraImg_cy ? source._extraImg_cx : sHeader.cx_extra;
                        const newZ = new Uint8Array(imgCx * imgCy);
                        for (let y = 0; y < imgCy; y++) {
                            for (let x = 0; x < imgCx; x++) {
                                const srcIdx = y * srcArrW + x;
                                const trgIdx = y * imgCx + x;
                                const pIdx = srcIdx < source.extraImageData.length ? source.extraImageData[srcIdx] : 0;
                                if (pIdx === 0 || !state.palette[pIdx]) {
                                    newZ[trgIdx] = 255; // 255 is transparent Z index
                                } else {
                                    const c = state.palette[pIdx];
                                    const brightness = (c.r + c.g + c.b) / 3;
                                    newZ[trgIdx] = Math.max(1, Math.min(31, Math.round(brightness * 31 / 255)));
                                }
                            }
                        }
                        target.extraZData = newZ;
                        target._extraZ_cx = imgCx; target._extraZ_cy = imgCy;
                    }
                } else if (mode === 'only_extra' || mode === 'full' || mode === 'place_merged') {
                    if (source.extraImageData) {
                        target.extraImageData = new Uint8Array(source.extraImageData);
                        target._extraImg_cx = imgCx; target._extraImg_cy = imgCy;
                    }
                    if (source.extraZData) {
                        target.extraZData = new Uint8Array(source.extraZData);
                        target._extraZ_cx = zCx; target._extraZ_cy = zCy;
                    }
                } else if (mode === 'img_extra' || mode === 'img_merged') {
                    if (source.extraImageData) {
                        target.extraImageData = new Uint8Array(source.extraImageData);
                        target._extraImg_cx = imgCx; target._extraImg_cy = imgCy;
                    }
                } else if (mode === 'z_extra' || mode === 'z_merged') {
                    if (source.extraZData) {
                        target.extraZData = new Uint8Array(source.extraZData);
                        target._extraZ_cx = zCx; target._extraZ_cy = zCy;
                    }
                }

                // 2. DIMENSION UPDATE
                // The shared header should always reflect the max footprint of the current target layers.
                const finalImgCx = target._extraImg_cx || 0;
                const finalImgCy = target._extraImg_cy || 0;
                const finalZCx = target._extraZ_cx || 0;
                const finalZCy = target._extraZ_cy || 0;

                tHeader.cx_extra = Math.max(finalImgCx, finalZCx);
                tHeader.cy_extra = Math.max(finalImgCy, finalZCy);
                tHeader.has_extra_data = 1;

                console.log(`[DEBUG COPY/PASTE] Target AFTER: tHeader.cx_extra = ${tHeader.cx_extra}, _extraZ_cx = ${target._extraZ_cx}, zData.length = ${target.extraZData ? target.extraZData.length : 0}, _extraImg_cx = ${target._extraImg_cx}, imgData.length = ${target.extraImageData ? target.extraImageData.length : 0}`);
                console.log(`[DEBUG COPY/PASTE] ---------------------------------`);

                // ... rest of offset logic ...

                // 3. OFFSET & METADATA
                const clean = (v, fallback = 0) => { const n = parseInt(v); return (isNaN(n) || !isFinite(n) || Math.abs(n) > 1e6) ? fallback : n; };
                const sBaseX = clean(source.baseX !== undefined ? source.baseX : sHeader.x);
                const sBaseY = clean(source.baseY !== undefined ? source.baseY : sHeader.y);
                const offX = clean(sHeader.x_extra) - sBaseX;
                const offY = clean(sHeader.y_extra) - sBaseY;

                tHeader.x_extra = clean(tHeader.x) + offX;
                tHeader.y_extra = clean(tHeader.y) + offY;
                tHeader.has_extra_data = (target.extraImageData || target.extraZData) ? 1 : 0;

                // IMPORTANT: Refresh derived properties (Bounding Box, itemMinX, etc.)
                target._v = (target._v || 0) + 1;
                moveTileBy(targetIdx, 0, 0, false);
            }
        }
    });
    recomputeWorldBoundsFromState();
    renderCanvas();
    recenterOnSelectedTiles();

    setTimeout(() => {
        if (typeof _layerThumbCache !== 'undefined' && _layerThumbCache.clear) _layerThumbCache.clear();
        updateTilesList();
        updateTileProperties();
        updateTileDataTable();
    }, 0);
}

/** Converts RGB Image to Indexed/Z-Data and injects into state */
function _pasteFromImageBuffer(imgData, mode, isForced) {
    const palette = state.palette;
    if (!palette && !mode.includes('z')) return;

    const w = imgData.width;
    const h = imgData.height;
    const pixels = imgData.data;
    const targets = isForced ? Array.from(state.tileSelection) : [];
    
    // Pass appropriate indices to pushHistory so undo stack properly isolates the changes!
    const isTotal = mode.includes('total');
    pushHistory(isTotal ? 'all' : (targets.length > 0 ? targets : null));
    
    console.log(`[_pasteFromImageBuffer] Input: ${w}x${h}, Mode: ${mode}, Forced: ${isForced}, Targets: ${targets.length}`);

    // Mode handling for "Whole Canvas" or "Merged Selection"
    const isMerged = mode.includes('merged');
    
    if (isTotal || (isMerged && targets.length > 0)) {
        const isZ = mode.includes('z');
        const halfCy = state.cy / 2;
        
        let minX = Infinity, minY = Infinity;
        
        if (isTotal) {
            minX = state.worldBounds.minX;
            minY = state.worldBounds.minY;
        } else {
            // Target dispatch bounds calculation - include BOTH base and extra to find correct image origin
            targets.forEach(idx => {
                const t = state.tiles[idx];
                if (!t || !t.tileHeader) return;
                const h = t.tileHeader;
                const elevation = state.flatCells ? 0 : h.height * halfCy;
                
                // Base check
                minX = Math.min(minX, h.x);
                minY = Math.min(minY, h.y - elevation);
                
                // Extra check (Crucial for vertical alignment consistency)
                if (h.has_extra_data && h.cx_extra > 0 && h.cy_extra > 0) {
                    minX = Math.min(minX, h.x_extra);
                    minY = Math.min(minY, h.y_extra - elevation);
                }
            });
        }

        const baseW = state.gameType === 'ts' ? 48 : 60;
        const baseH = state.gameType === 'ts' ? 24 : 30;
        const workSet = isTotal ? state.tiles.map((_, i) => i) : targets;

        // --- TWO-PASS "GREEN MASK" DISPATCH ---
        const occupancy = new Uint8Array(imgData.width * imgData.height);
        const sortedIndices = [...workSet].sort((a, b) => parseInt(b) - parseInt(a));

        // Exact Westwood-Style Line Tracer for 2:1 Isometric Diamonds
        const isInsideWestwoodDiamond = (lx, ly, cx, cy) => {
            const halfW = Math.floor(cx / 2);
            const halfH = Math.floor(cy / 2);
            let ry;
            // First half (top to middle) vs second half (middle to bottom)
            if (ly < halfH) ry = ly;
            else ry = cy - 1 - ly - 1;
            if (ry < 0) return false;

            // XCC/Westwood logic: width increases by 4 each line starting with 4-pixel tip
            const xOffset = halfW - (ry + 1) * 2;
            const cxRow = (ry + 1) * 4;
            return (lx >= xOffset && lx < (xOffset + cxRow));
        };

        const bg = state.palette[0] || { r: 0, g: 0, b: 255 };
        
        // PASTE DEBUG
        if (!isZ) {
            const pr = pixels[0], pg = pixels[1], pb = pixels[2], pa = pixels[3];
            console.log(`[PASTE DEBUG] Pixel (0,0) RGB: (${pr}, ${pg}, ${pb}), Alpha: ${pa}`);
            console.log(`[PASTE DEBUG] Chroma Target RGB: (${bg.r}, ${bg.g}, ${bg.b})`);
        }

        const extract = (targetX, targetY, targetW, targetH, isDiamondMask = false, mode = 'extract') => {
            const out = new Uint8Array(targetW * targetH);
            for (let y = 0; y < targetH; y++) {
                for (let x = 0; x < targetW; x++) {
                    // 1. Geometric Diamond Mask (Matching XCC grid logic)
                    if (isDiamondMask) {
                        if (!isInsideWestwoodDiamond(x, y, targetW, targetH)) continue;
                    }

                    const srcX = Math.floor(targetX - minX + x);
                    const srcY = Math.floor(targetY - minY + y);
                    
                    if (srcX >= 0 && srcX < imgData.width && srcY >= 0 && srcY < imgData.height) {
                        const occIdx = srcY * imgData.width + srcX;
                        
                        // Check for global occupancy (claimed by a Tile in front of us, or our own Extra object)
                        if (occupancy[occIdx] === 1) {
                            out[y * targetW + x] = isZ ? 255 : 0; 
                            continue;
                        }

                        const offset = occIdx * 4;
                        const r = pixels[offset], g = pixels[offset+1], b = pixels[offset+2], a = pixels[offset+3];
                        
                        // Opaque pixel check (Alpha < 128 = Transparent)
                        if (a < 128) {
                            out[y * targetW + x] = isZ ? 255 : 0;
                            continue;
                        }

                        // Chroma Key Protection: If pixel matches the background color used for copy, treat as transparent.
                        const dR = r - bg.r;
                        const dG = g - bg.g;
                        const dB = b - bg.b;
                        const distSq = dR * dR + dG * dG + dB * dB;
                        if (!isZ && distSq < 25) {
                            out[y * targetW + x] = 0;
                            continue;
                        }

                        let val = 0;
                        if (isZ) {
                            const gray = (r + g + b) / 3;
                            val = Math.max(0, Math.min(31, Math.round(gray * 31 / 255)));
                        } else {
                            val = _findClosestPaletteIndex(r, g, b, palette);
                        }

                        out[y * targetW + x] = val;
                        // Claim occupancy
                        if (val !== (isZ ? 255 : 0)) {
                            occupancy[occIdx] = 1;
                        }

                    } else {
                        out[y * targetW + x] = isZ ? 255 : 0;
                    }
                }
            }
            return out;
        };

        // PASS: Front-to-Back extraction mimicking exact draw order
        sortedIndices.forEach(idx => {
            const t = state.tiles[idx];
            if (!t || !t.tileHeader) return;
            const elevation = state.flatCells ? 0 : t.tileHeader.height * halfCy;
            
            // Extract Base Diamonds FIRST (User preferred priority: base cell gets pixels, leftover is for extra data)
            const cellBuffer = extract(t.tileHeader.x, t.tileHeader.y - elevation, baseW, baseH, true, 'diamond');
            
            if (isZ) {
                _mergeBuffers(t.zData, cellBuffer, true, isForced);
            } else {
                _mergeBuffers(t.data, cellBuffer, false, isForced);
            }

            // Extract Extra Data SECOND (underneath its own base data in priority)
            if (t.tileHeader.has_extra_data) {
                // CRITICAL: Use PER-LAYER independent dimensions, NOT shared tileHeader.cx_extra.
                // tileHeader.cx_extra is a shared field that may reflect a DIFFERENT layer's last resize.
                // The independent dims (_extraImg_cx, _extraZ_cx) are the ground truth per layer.
                let eW, eH;
                if (isZ) {
                    // For Z extraction: prefer _extraZ_cx, fall back to shared only if no independent dims exist
                    eW = (t._extraZ_cx && t.extraZData && t.extraZData.length >= t._extraZ_cx * t._extraZ_cy) ? t._extraZ_cx : (t.tileHeader.cx_extra || 0);
                    eH = (t._extraZ_cy && t.extraZData && t.extraZData.length >= t._extraZ_cx * t._extraZ_cy) ? t._extraZ_cy : (t.tileHeader.cy_extra || 0);
                } else {
                    // For image extraction: prefer _extraImg_cx
                    eW = (t._extraImg_cx && t.extraImageData && t.extraImageData.length >= t._extraImg_cx * t._extraImg_cy) ? t._extraImg_cx : (t.tileHeader.cx_extra || 0);
                    eH = (t._extraImg_cy && t.extraImageData && t.extraImageData.length >= t._extraImg_cx * t._extraImg_cy) ? t._extraImg_cy : (t.tileHeader.cy_extra || 0);
                }

                if (eW > 0 && eH > 0) {
                    const exBuffer = extract(t.tileHeader.x_extra, t.tileHeader.y_extra - elevation, eW, eH, false, 'extra');
                    
                    if (isZ) {
                        // Always replace with new buffer at the extraction size (which IS the layer's actual size)
                        t.extraZData = new Uint8Array(exBuffer);
                        t._extraZ_cx = eW;
                        t._extraZ_cy = eH;
                    } else {
                        // Always replace with new buffer at the extraction size
                        t.extraImageData = new Uint8Array(exBuffer);
                        t._extraImg_cx = eW;
                        t._extraImg_cy = eH;
                    }
                }
            }
        });

        recomputeWorldBoundsFromState();
        renderCanvas();
        updateTilesList();
        return;
    }

    // --- Legacy / Single Tile Fallback ---


    // 1. Process to Buffer (Indexed or Grayscale) for single tile paste
    const isZMode = mode.includes('z');
    const buffer = new Uint8Array(w * h);
    const tW = state.cx;
    const tH = state.cy;
    
    for (let i = 0; i < w * h; i++) {
        const offset = i * 4;
        const r = pixels[offset];
        const g = pixels[offset+1];
        const b = pixels[offset+2];
        const a = pixels[offset+3];
        
        if (isZMode) {
            // Take Gray and scale back from 0-255 to 0-31 for TMP 5-bit Z-buffer
            if (a < 128) {
                buffer[i] = 0;
            } else {
                const gray = (r + g + b) / 3;
                buffer[i] = Math.max(0, Math.min(31, Math.round(gray * 31 / 255)));
            }
        } else {
            // Find closest palette index
            if (a < 128) {
                buffer[i] = 0; // Transparent
            } else {
                buffer[i] = _findClosestPaletteIndex(r, g, b, palette);
            }
        }
    }

    if (isForced && targets.length > 0) {
        targets.forEach(idx => {
            const t = state.tiles[idx];
            if (!t) return;

            // 1. Data/Z-Cell Merging (Standard Cell Sizes, no resizing needed)
            if (mode === 'img_cell' || mode === 'img_merged') {
                if (w === tW && h === tH) {
                    _mergeBuffers(t.data, buffer, false, isForced);
                }
            }
            if (mode === 'z_cell') {
                if (w === tW && h === tH) {
                    _mergeBuffers(t.zData, buffer, true, isForced);
                }
            }

            // 2. Extra Data Handling (single-tile paste from system clipboard image)
            // PHILOSOPHY: The pasted image w×h IS the truth. Convert pixels → format, replace buffer.
            // No dependency on what was there before. No size matching required.
            if (mode.includes('extra') || mode === 'z_extra') {
                const isZMode = mode.includes('z');
                
                // Ensure tile has header
                if (!t.tileHeader) {
                    t.tileHeader = { 
                        x: 0, y: 0, height: 0, terrain_type: 0, ramp_type: 0,
                        has_extra_data: 0, cx_extra: 0, cy_extra: 0,
                        x_extra: 0, y_extra: 0
                    };
                }

                // Sanitize coordinates if garbage
                const hadExtra = !!(t.extraImageData || t.extraZData);
                if (!hadExtra || t.tileHeader.x_extra > 1000000 || t.tileHeader.x_extra < -1000000) {
                    t.tileHeader.x_extra = t.tileHeader.x;
                    t.tileHeader.y_extra = t.tileHeader.y;
                }

                // Assign the new buffer and its INDEPENDENT dimensions for the target layer.
                // IMPORTANT: Do NOT touch the sister layer's buffer or independent dims.
                // Before overwriting shared header, bake the sibling layer if needed.
                console.warn(`[DEBUG SYS-PASTE] --- SYSTEM CLIPBOARD MERGE (${mode}) ---`);
                console.log(`[DEBUG SYS-PASTE] Pasted Buffer size: ${w}x${h} (${w*h} bytes)`);
                console.log(`[DEBUG SYS-PASTE] Target BEFORE: t.tileHeader.cx_extra = ${t.tileHeader.cx_extra}, _extraZ_cx = ${t._extraZ_cx}, zData.length = ${t.extraZData ? t.extraZData.length : 0}, _extraImg_cx = ${t._extraImg_cx}, imgData.length = ${t.extraImageData ? t.extraImageData.length : 0}`);

                if (isZMode) {
                    t.extraZData = new Uint8Array(buffer);
                    t._extraZ_cx = w;
                    t._extraZ_cy = h;
                    if (t.extraImageData && !t._extraImg_cx) {
                        t._extraImg_cx = t.tileHeader.cx_extra || 0;
                        t._extraImg_cy = t.tileHeader.cy_extra || 0;
                    }
                } else {
                    t.extraImageData = new Uint8Array(buffer);
                    t._extraImg_cx = w;
                    t._extraImg_cy = h;
                    if (t.extraZData && !t._extraZ_cx) {
                        t._extraZ_cx = t.tileHeader.cx_extra || 0;
                        t._extraZ_cy = t.tileHeader.cy_extra || 0;
                    }
                }

                // Update shared header to accurately reflect the maximum footprint
                const finalImgCx = t._extraImg_cx || 0;
                const finalImgCy = t._extraImg_cy || 0;
                const finalZCx = t._extraZ_cx || 0;
                const finalZCy = t._extraZ_cy || 0;
                
                t.tileHeader.cx_extra = Math.max(finalImgCx, finalZCx);
                t.tileHeader.cy_extra = Math.max(finalImgCy, finalZCy);
                t.tileHeader.has_extra_data = 1;
                t.tileHeader.flags = (t.tileHeader.flags || 0) | 1;

                console.log(`[DEBUG SYS-PASTE] Target AFTER: t.tileHeader.cx_extra = ${t.tileHeader.cx_extra}, _extraZ_cx = ${t._extraZ_cx}, zData.length = ${t.extraZData ? t.extraZData.length : 0}, _extraImg_cx = ${t._extraImg_cx}, imgData.length = ${t.extraImageData ? t.extraImageData.length : 0}`);
                console.log(`[DEBUG SYS-PASTE] ----------------------------------------`);

                // Invalidate cache and recompute derived tile fields
                t._v = (t._v || 0) + 1;
                moveTileBy(idx, 0, 0, false);

                console.log(`  [Paste:Extra] Layer '${isZMode ? 'Z' : 'Img'}' updated to ${w}x${h} from pasted image.`);
            }
        });
    } else {
        // Create NEW tile
        const tW = state.gameType === 'ts' ? 48 : 60;
        const tH = state.gameType === 'ts' ? 24 : 30;
        const newTile = {
            id: generateId(),
            name: `Tile ${state.tiles.length}`,
            width: tW,
            height: tH,
            data: new Uint8Array(tW * tH),
            zData: new Uint8Array(tW * tH),
            tileHeader: {
                 x: 0, y: 0, extra_ofs: 0, z_ofs: 0, extra_z_ofs: 0,
                 x_extra: 0, y_extra: 0, cx_extra: 0, cy_extra: 0,
                 flags: 0, height: 0, terrain_type: 0, ramp_type: 0,
                 has_extra_data: 0,
                 radar_red_left: 0, radar_green_left: 0, radar_blue_left: 0,
                 radar_red_right: 0, radar_green_right: 0, radar_blue_right: 0
            }
        };

        if (mode === 'img_cell' || mode === 'img_merged') {
            newTile.data = new Uint8Array(tW * tH).fill(0); // Initialize with standard size
            if (w === tW && h === tH) {
                newTile.data.set(buffer);
            }
        }
        
        if (mode === 'img_extra' || mode === 'img_merged') {
            if (mode === 'img_extra' || (w !== tW || h !== tH)) {
                newTile.extraImageData = new Uint8Array(buffer);
                newTile.tileHeader.cx_extra = w;
                newTile.tileHeader.cy_extra = h;
                newTile.tileHeader.has_extra_data = 1;
            }
        }
        
        if (mode === 'z_cell') {
            newTile.zData = new Uint8Array(tW * tH).fill(0);
            if (w === tW && h === tH) {
                newTile.zData.set(buffer);
            }
        }
        
        if (mode === 'z_extra' || mode === 'z_merged') {
            if (mode === 'z_extra' || (w !== tW || h !== tH)) {
                newTile.extraZData = new Uint8Array(buffer);
                newTile.tileHeader.cx_extra = w;
                newTile.tileHeader.cy_extra = h;
                newTile.tileHeader.has_extra_data = 1;
            }
        }
        state.tiles.push(newTile);
        
        // Auto-select the newly created tile
        state.tileSelection.clear();
        state.tileSelection.add(state.tiles.length - 1);
        state.currentTileIdx = state.tiles.length - 1;
    }
    
    recomputeWorldBoundsFromState();
    renderCanvas();
    updateTilesList();
}

/** Slices a pixel region and converts to Z-Buffer (Mask) */
function _extractRegionFromImageData(imgData, rx, ry, rw, rh, isZ = false) {
    const buffer = new Uint8Array(rw * rh);
    const pixels = imgData.data;
    const iw = imgData.width;
    const ih = imgData.height;
    
    for (let y = 0; y < rh; y++) {
        const py = ry + y;
        if (py < 0 || py >= ih) continue;
        for (let x = 0; x < rw; x++) {
            const px = rx + x;
            if (px < 0 || px >= iw) continue;
            
            const destOffset = y * rw + x;
            const srcOffset = (py * iw + px) * 4;
            
            if (isZ) {
                // Grayscale average
                buffer[destOffset] = Math.round((pixels[srcOffset] + pixels[srcOffset+1] + pixels[srcOffset+2]) / 3);
            }
        }
    }
    return buffer;
}

/** Euclidean Color Distance Matcher
 * Returns the closest palette index to the given RGB color.
 * IMPORTANT: Never returns index 0 (which is always the transparent slot in image buffers),
 * even if palette[0] happens to be the nearest color. In that case it returns the second-nearest.
 */
function _findClosestPaletteIndex(r, g, b, palette) {
    let bestIdx = 1;      // best non-zero index
    let bestDist = Infinity;
    let zeroIsBest = false;

    // Pass 1: find true best across ALL indices
    let trueMinIdx = 1, trueMinDist = Infinity;
    for (let i = 0; i < 256; i++) {
        const col = palette[i];
        if (!col) continue;
        const dist = (r - col.r) ** 2 + (g - col.g) ** 2 + (b - col.b) ** 2;
        if (dist < trueMinDist) { trueMinDist = dist; trueMinIdx = i; }
    }

    // If the true winner is index 0, we must find the best non-zero alternative
    // because index 0 in an image buffer always means transparent (not drawn).
    if (trueMinIdx === 0) {
        for (let i = 1; i < 256; i++) {
            const col = palette[i];
            if (!col) continue;
            const dist = (r - col.r) ** 2 + (g - col.g) ** 2 + (b - col.b) ** 2;
            if (dist < bestDist) { bestDist = dist; bestIdx = i; }
        }
        return bestIdx;
    }
    return trueMinIdx;
}

/** Utility to merge two indexed buffers (skipping transparent index: 0 for Image, 255 for Z) */
function _mergeBuffers(target, source, isZ = false, overwrite = false) {
    if (!target || !source) {
        return;
    }
    
    if (overwrite) {
        target.set(source.subarray(0, Math.min(target.length, source.length)));
        return;
    }

    if (target.length !== source.length) {
        return;
    }

    for (let i = 0; i < target.length; i++) {
        const val = source[i];
        if (isZ) {
            if (val !== 255) target[i] = val;
        } else {
            if (val !== 0) target[i] = val;
        }
    }
}

/** Utility to resize/pad/crop a buffer to new dimensions */
function _resampleBuffer(oldBuffer, oldW, oldH, newW, newH, isZ = false) {
    const newBuffer = new Uint8Array(newW * newH).fill(isZ ? 255 : 0);
    if (!oldBuffer || oldW <= 0 || oldH <= 0) return newBuffer;

    const copyW = Math.min(oldW, newW);
    const copyH = Math.min(oldH, newH);

    for (let y = 0; y < copyH; y++) {
        for (let x = 0; x < copyW; x++) {
            newBuffer[y * newW + x] = oldBuffer[y * oldW + x];
        }
    }
    return newBuffer;
}

export function pasteExtraDataIntoSelectedTiles(recalculateRelative = false) {
    if (!state.tileClipboard || state.tileClipboard.length === 0) return;
    if (state.tileSelection.size === 0) return;

    pushHistory();
    const sortedTarget = Array.from(state.tileSelection).sort((a, b) => a - b);
    
    sortedTarget.forEach((targetIdx, i) => {
        const source = state.tileClipboard[i % state.tileClipboard.length];
        const target = state.tiles[targetIdx];
        if (!target || !source) return;

        const clean = (v, fallback = 0) => {
            const num = parseInt(v);
            if (isNaN(num) || !isFinite(num) || Math.abs(num) > 1000000) return fallback;
            return num;
        };

        // Smart merge: ONLY copy the extra/metadata layers, keep the base diamond
        if (source.extraImageData || (source.tileHeader && source.tileHeader.has_extra_data)) {
            if (!target.tileHeader) target.tileHeader = { has_extra_data: 0 };
            
            let cx = clean(source.tileHeader?.cx_extra);
            let cy = clean(source.tileHeader?.cy_extra);
            if (cx < 0 || cx > 2048 || cy < 0 || cy > 2048) { cx = 0; cy = 0; }

            const hasBuffer = !!source.extraImageData;
            if (hasBuffer && (source.extraImageData.length >= cx * cy)) {
                target.extraImageData = new Uint8Array(source.extraImageData);
                target.extraZData = source.extraZData ? new Uint8Array(source.extraZData) : null;
            } else if (cx > 0 && cy > 0) {
                target.extraImageData = new Uint8Array(cx * cy).fill(0);
                target.extraZData = null;
            } else {
                target.extraImageData = null;
                target.extraZData = null;
            }

            if (source.tileHeader && target.tileHeader) {
                target.tileHeader.has_extra_data = (target.extraImageData ? 1 : 0);
                target.tileHeader.cx_extra = cx;
                target.tileHeader.cy_extra = cy;
                
                if (recalculateRelative) {
                    // Offset = SourceExtra - SourceBase
                    const offX = clean(source.tileHeader.x_extra) - clean(source.baseX || source.tileHeader.x);
                    const offY = clean(source.tileHeader.y_extra) - clean(source.baseY || source.tileHeader.y);
                    target.tileHeader.x_extra = clean(target.tileHeader.x) + offX;
                    target.tileHeader.y_extra = clean(target.tileHeader.y) + offY;
                } else {
                    target.tileHeader.x_extra = clean(source.tileHeader.x_extra);
                    target.tileHeader.y_extra = clean(source.tileHeader.y_extra);
                }
                
                target.extraX = clean(source.extraX);
                target.extraY = clean(source.extraY);
            }
        }
    });

    recomputeWorldBoundsFromState();
    renderCanvas();
    recenterOnSelectedTiles();
    
    // Defer DOM update to ensure state and canvas have settled
    setTimeout(() => {
        if (typeof _layerThumbCache !== 'undefined' && _layerThumbCache.clear) _layerThumbCache.clear();
        updateTilesList();
        updateTileProperties();
        updateTileDataTable();
    }, 0);
}

export function pasteIntoSelectedTiles() {
    // 1. If local clipboard is empty, try to restore from cross-tab localStorage
    if (!state.tileClipboard || state.tileClipboard.length === 0) {
        try {
            const raw = localStorage.getItem('tmp_tile_clipboard');
            if (raw) {
                const bundle = JSON.parse(raw);
                if (bundle.type === 'tmp_tiles' && Array.isArray(bundle.tiles)) {
                    state.tileClipboard = bundle.tiles.map(t => ({
                        ...t,
                        data: t.data ? new Uint8Array(t.data) : null,
                        zData: t.zData ? new Uint8Array(t.zData) : null,
                        extraImageData: t.extraImageData ? new Uint8Array(t.extraImageData) : null,
                        extraZData: t.extraZData ? new Uint8Array(t.extraZData) : null,
                        damagedData: t.damagedData ? new Uint8Array(t.damagedData) : null,
                        tileHeader: t.tileHeader ? { ...t.tileHeader } : null
                    }));
                    state.tileClipboardMetadata = bundle.metadata || { isExtraOnly: false, isBaseOnly: false, count: state.tileClipboard.length };
                }
            }
        } catch (e) { }
    }

    if (!state.tileClipboard || state.tileClipboard.length === 0) return;

    // RULE: Strict game-type check
    if (state.tileClipboardMetadata?.gameType && state.tileClipboardMetadata.gameType !== state.gameType) {
        console.warn(`[PasteInto] Cross-game paste ignored.`);
        return;
    }

    const isExtraOnly = state.tileClipboardMetadata?.isExtraOnly || false;

    // Generalized Overwrite (Supports 1-to-many via modulo)
    pushHistory();
    const sortedTarget = Array.from(state.tileSelection).sort((a, b) => a - b);
    
    sortedTarget.forEach((targetIdx, i) => {
        const source = state.tileClipboard[i % state.tileClipboard.length];
        const target = state.tiles[targetIdx];
        if (!target || !source) return;

        const clean = (v, fallback = 0) => {
            const num = parseInt(v);
            if (isNaN(num) || !isFinite(num) || Math.abs(num) > 1000000) return fallback;
            return num;
        };

        // For Ctrl+Shift+V, we usually want to replace everything except the world position X,Y
        // Or if it's Extra Only, we just fuse extra.
        
        if (isExtraOnly) {
            // Overwrite Extra Data in target (recalculating relative offsets)
            // Note: If target didn't have extra, it gets it. If it did, it's replaced.
            applyExtraOnlyMerge(target, source, clean, true);
            target._v = (target._v || 0) + 1;
        } else {
            // Full Overwrite keeping target world coords
            const targetX = target.tileHeader?.x || 0;
            const targetY = target.tileHeader?.y || 0;
            
            // Overwrite Base
            if (source.data) {
                target.data = new Uint8Array(source.data);
                target.zData = source.zData ? new Uint8Array(source.zData) : null;
                target.damagedData = source.damagedData ? new Uint8Array(source.damagedData) : null;
                if (source.tileHeader) {
                    if (!target.tileHeader) target.tileHeader = { ...source.tileHeader };
                    target.tileHeader.height = clean(source.tileHeader.height);
                    target.tileHeader.land_type = clean(source.tileHeader.land_type);
                    target.tileHeader.ramp_type = clean(source.tileHeader.ramp_type);
                }
                // Keep target position
                if (target.tileHeader) {
                    target.tileHeader.x = targetX;
                    target.tileHeader.y = targetY;
                }
            }

            // Overwrite/Manage Extra
            applyExtraOnlyMerge(target, source, clean, true);
            target._v = (target._v || 0) + 1;
        }
    });

    recomputeWorldBoundsFromState();
    renderCanvas();
    recenterOnSelectedTiles();
    
    // Defer DOM update to ensure state and canvas have settled
    setTimeout(() => {
        if (typeof _layerThumbCache !== 'undefined' && _layerThumbCache.clear) _layerThumbCache.clear();
        updateTilesList();
        updateTileProperties();
        updateTileDataTable();
    }, 0);
}

/**
 * Internal helper for recalibrating extra data coordinates during merge/overwrite.
 */
function applyExtraOnlyMerge(target, source, clean, recalculateRelative) {
    if (!source.extraImageData && !source.extraZData && !(source.tileHeader && source.tileHeader.has_extra_data)) {
        return; // Nothing to merge
    }

    if (!target.tileHeader) {
        target.tileHeader = { has_extra_data: 0, x_extra:0, y_extra:0, cx_extra:0, cy_extra:0, x: 0, y: 0 };
    }
    
    const sCX = source.tileHeader?.cx_extra || 0;
    const sCY = source.tileHeader?.cy_extra || 0;
    const tCX = (target.tileHeader?.has_extra_data) ? (target.tileHeader.cx_extra || 0) : 0;
    const tCY = (target.tileHeader?.has_extra_data) ? (target.tileHeader.cy_extra || 0) : 0;

    // Sanitize coordinates if target didn't have extra or has garbage
    if (!target.tileHeader.has_extra_data || Math.abs(target.tileHeader.x_extra) > 1000000) {
        target.tileHeader.x_extra = target.tileHeader.x || 0;
        target.tileHeader.y_extra = target.tileHeader.y || 0;
    }

    if (sCX <= 0 || sCY <= 0) return;

    // Full Override: Do NOT merge pixels during a Paste Into operation.
    // Replace the buffer entirely so that the exact dimensions and graphics are copied.
    if (source.extraImageData) {
        target.extraImageData = new Uint8Array(source.extraImageData);
        target._extraImg_cx = sCX;
        target._extraImg_cy = sCY;
    }

    if (source.extraZData) {
        target.extraZData = new Uint8Array(source.extraZData);
        target._extraZ_cx = sCX;
        target._extraZ_cy = sCY;
    }

    if (source.tileHeader && target.tileHeader) {
        target.tileHeader.has_extra_data = (target.extraImageData ? 1 : 0);
        
        // Always force header dimensions to match the newly pasted source
        target.tileHeader.cx_extra = sCX;
        target.tileHeader.cy_extra = sCY;
        
        if (recalculateRelative) {
             const sBaseX = clean(source.baseX !== undefined ? source.baseX : (source.tileHeader ? source.tileHeader.x : 0));
             const sBaseY = clean(source.baseY !== undefined ? source.baseY : (source.tileHeader ? source.tileHeader.y : 0));
             const offX = clean(source.tileHeader.x_extra) - sBaseX;
             const offY = clean(source.tileHeader.y_extra) - sBaseY;
             target.tileHeader.x_extra = clean(target.tileHeader.x) + offX;
             target.tileHeader.y_extra = clean(target.tileHeader.y) + offY;
        } else {
             target.tileHeader.x_extra = clean(source.tileHeader.x_extra);
             target.tileHeader.y_extra = clean(source.tileHeader.y_extra);
        }
        
        // Synchronize derived rendering fields
        target.extraX = target.tileHeader.x_extra;
        target.extraY = target.tileHeader.y_extra;
    }
}


export function pasteTilesAtEnd(mode = 'full') {
    // If local clipboard is empty, try to restore from cross-tab localStorage
    if (!state.tileClipboard || state.tileClipboard.length === 0) {
        try {
            const raw = localStorage.getItem('tmp_tile_clipboard');
            if (raw) {
                const bundle = JSON.parse(raw);
                if (bundle.type === 'tmp_tiles' && Array.isArray(bundle.tiles)) {
                    state.tileClipboard = bundle.tiles.map(t => ({
                        ...t,
                        data: t.data ? new Uint8Array(t.data) : null,
                        zData: t.zData ? new Uint8Array(t.zData) : null,
                        extraImageData: t.extraImageData ? new Uint8Array(t.extraImageData) : null,
                        extraZData: t.extraZData ? new Uint8Array(t.extraZData) : null,
                        damagedData: t.damagedData ? new Uint8Array(t.damagedData) : null,
                        tileHeader: t.tileHeader ? { ...t.tileHeader } : null
                    }));
                }
            }
        } catch (e) {
            console.warn("Failed to restore clipboard:", e);
        }
    }

    if (!state.tileClipboard || state.tileClipboard.length === 0) return;

    pushHistory();
    const newTiles = state.tileClipboard.map(t => {
        const copy = {
            ...t,
            id: generateId(),
            data: t.data ? new Uint8Array(t.data) : null,
            zData: t.zData ? new Uint8Array(t.zData) : null,
            extraImageData: t.extraImageData ? new Uint8Array(t.extraImageData) : null,
            extraZData: t.extraZData ? new Uint8Array(t.extraZData) : null,
            damagedData: t.damagedData ? new Uint8Array(t.damagedData) : null,
            tileHeader: t.tileHeader ? { ...t.tileHeader } : null
        };

        // Mode masking for data-to-new-tile
        if (mode === 'only_cell') {
            copy.extraImageData = null;
            copy.extraZData = null;
            if (copy.tileHeader) copy.tileHeader.has_extra_data = 0;
        } else if (mode === 'only_extra') {
            const diamW = state.gameType === 'ts' ? 48 : 60;
            const diamH = state.gameType === 'ts' ? 24 : 30;
            const diamondSize = (diamW * diamH) / 2;
            copy.data = new Uint8Array(diamondSize).fill(0);
            copy.zData = new Uint8Array(diamondSize).fill(0);
        }
        return copy;
    });

    const startIdx = state.tiles.length;
    state.tiles.push(...newTiles);

    // Dynamic grid expansion
    const actualCount = state.tiles.length;
    const currentGrid = state.cblocks_x * state.cblocks_y;
    if (actualCount > currentGrid) {
        const bx = state.cblocks_x;
        const by = Math.ceil(actualCount / bx);
        state.cblocks_y = by;
        if (state.tmpData && state.tmpData.header) {
            state.tmpData.header.cblocks_y = by;
        }
    }

    // Auto-select pasted tiles
    if (state.tileSelection) {
        state.tileSelection.clear();
        for (let i = 0; i < newTiles.length; i++) {
            state.tileSelection.add(startIdx + i);
        }
    }

    updateTilesList();
    recomputeWorldBoundsFromState(); 
    renderCanvas();

    // Scroll to end
    if (elements.tilesList) {
        elements.tilesList.scrollTop = elements.tilesList.scrollHeight;
    }
}

export function resetFramesList() {
    if (elements.tilesList) {
        elements.tilesList.innerHTML = '';
        elements.tilesList._hasScrollListener = false;
    }
}
// --- PALETTE RENDERING ---
export function renderPalette() {
    if (!elements.paletteGrid) {
        return; // Palette grid removed from main interface as requested
    }
    elements.paletteGrid.innerHTML = '';

    const maxCells = 256;
    for (let i = 0; i < maxCells; i++) {
        const div = document.createElement('div');
        div.className = 'pal-cell';
        div.dataset.idx = i;
        div.draggable = true;

        const color = state.palette[i];

        // Hover tooltips formatted professionally
        if (color) {
            div.style.backgroundColor = `rgb(${color.r},${color.g},${color.b})`;
            div.setAttribute('data-tooltip', `${state.translations.tt_idx}: ${i}\n${state.translations.tt_rgb}: ${color.r},${color.g},${color.b}`);
        } else {
            div.style.backgroundColor = '';
            div.classList.add(i % 2 === 0 ? 'empty-p1' : 'empty-p2');
            div.setAttribute('data-tooltip', `${state.translations.tt_idx}: ${i}\n${state.translations.tt_rgb}: ${state.translations.tt_empty}`);
        }

        if (state.paletteSelection.has(i)) {
            div.classList.add('selected');
        }

        // --- Drag Events ---
        div.ondragstart = (e) => {
            // Ensure the clicked index is part of selection if not already
            if (!state.paletteSelection.has(i)) {
                if (!e.ctrlKey && !e.shiftKey) state.paletteSelection.clear();
                state.paletteSelection.add(i);
                state.lastPaletteIdx = i;
                renderPalette();
            }

            state.dragSourceType = 'palette';
            const idxs = Array.from(state.paletteSelection).sort((a, b) => a - b);
            state.dragSourceCount = idxs.length;

            e.dataTransfer.setData('application/json', JSON.stringify({
                t: 'palette',
                i: idxs
            }));
            e.dataTransfer.setData('text/plain', 'palette'); // Compatibility
            e.dataTransfer.effectAllowed = 'copy';
        };

        div.ondragend = () => {
            state.dragSourceType = null;
            state.dragSourceCount = 0;
            // Clear highlights manually just in case
            document.querySelectorAll('.drop-target, .overwrite-target, .swap-target').forEach(el => {
                el.classList.remove('drop-target', 'overwrite-target', 'swap-target');
            });
        };

        div.onpointerdown = handlePaletteSelect;

        if (elements.paletteGrid) elements.paletteGrid.appendChild(div);
    }
}

export function setupZoomOptions() {
    if (!elements.inpZoom) return;

    // Sync Slider
    const syncZoomUI = () => {
        const pct = state.zoom * 100;
        if (elements.inpZoom) elements.inpZoom.value = pct;
        if (elements.zoomVal) elements.zoomVal.innerText = Math.round(pct) + "%";
        if (elements.zoomSizeBar) {
            const range = elements.inpZoom.max - elements.inpZoom.min;
            const val = pct - elements.inpZoom.min;
            const ratio = (val / range) * 100;
            elements.zoomSizeBar.style.width = ratio + "%";
        }
    };

    elements.inpZoom.oninput = (e) => {
        let val = parseInt(e.target.value);

        if (val > 50 && val < 100) {
            val = (val > 75) ? 100 : 50;
            e.target.value = val;
        } else if (val > 100) {
            val = Math.round(val / 100) * 100;
            e.target.value = val;
        }

        const container = elements.canvasWrapper.parentElement;
        const oldZoom = state.zoom;
        const newZoom = val / 100;

        const canvasW = state.canvasW * oldZoom;
        const canvasH = state.canvasH * oldZoom;

        const visualX = (canvasW < container.clientWidth) ? canvasW / 2 : (container.scrollLeft + container.clientWidth / 2);
        const visualY = (canvasH < container.clientHeight) ? canvasH / 2 : (container.scrollTop + container.clientHeight / 2);

        const centerCanvasX = visualX / oldZoom;
        const centerCanvasY = visualY / oldZoom;

        state.zoom = newZoom;
        updateCanvasSize();
        renderCanvas();
        syncZoomUI();

        container.scrollLeft = centerCanvasX * newZoom - container.clientWidth / 2;
        container.scrollTop = centerCanvasY * newZoom - container.clientHeight / 2;
    };

    // Wheel Zoom Support
    if (elements.canvasWrapper && elements.canvasWrapper.parentElement) {
        elements.canvasWrapper.parentElement.onwheel = (e) => {
            if (e.ctrlKey) {
                e.preventDefault();
                const direction = e.deltaY < 0 ? 1 : -1;
                let current = parseInt(elements.inpZoom.value);
                let next;

                if (direction > 0) {
                    next = current < 100 ? 100 : Math.floor(current / 100) * 100 + 100;
                } else {
                    next = current <= 100 ? 50 : Math.ceil(current / 100) * 100 - 100;
                }

                const min = parseInt(elements.inpZoom.min) || 50;
                const max = parseInt(elements.inpZoom.max) || 5000;
                next = Math.max(min, Math.min(max, next));

                if (next !== current) {
                    if (elements.inpZoom) elements.inpZoom.value = next;
                    if (elements.inpZoom) elements.inpZoom.dispatchEvent(new Event('input'));
                }
            }
        };
    }

    if (elements.btnZoomReset) {
        elements.btnZoomReset.onclick = () => {
            if (elements.inpZoom) elements.inpZoom.value = 100;
            if (elements.inpZoom) elements.inpZoom.dispatchEvent(new Event('input'));
        };
    }

    syncZoomUI();
}

export function renderPaletteSimple(palette, container) {
    if (!container) return;
    container.innerHTML = '';

    // Ensure container has grid class if missing (though it should be in HTML)
    if (!container.classList.contains('palette-grid-wrapper')) {
        container.classList.add('palette-grid-wrapper');
    }

    for (let i = 0; i < 256; i++) {
        const div = document.createElement('div');
        div.className = 'pal-cell';
        const c = palette[i];
        if (c) {
            div.style.backgroundColor = `rgb(${c.r},${c.g},${c.b})`;
            div.title = `Index ${i}: ${c.r},${c.g},${c.b}`;
        } else {
            // Checkerboard pattern for empty cells
            div.style.backgroundColor = '';
            div.classList.add(((i % 32) + Math.floor(i / 32)) % 2 === 0 ? 'empty-p1' : 'empty-p2');
            div.title = `Index ${i}: Empty`;
        }
        container.appendChild(div);
    }
}

/**
 * Shows a centered custom confirmation dialog.
 * @param {string} title - The title of the dialog.
 * @param {string} message - The message to display (optional).
 * @returns {Promise<boolean>} - Resolves to true if confirmed, false otherwise.
 */
/**
 * Custom Alert Dialog
 */
export async function showAlert(title, message = "") {
    const dialog = document.getElementById('alertDialog');
    const msgEl = document.getElementById('alertMessage');
    const titleEl = document.getElementById('alertTitle');
    const btnOk = document.getElementById('btnAlertOk');

    if (!dialog || !msgEl || !btnOk) {
        alert(message ? `${title}\n\n${message}` : title);
        return;
    }

    titleEl.textContent = title;
    msgEl.innerHTML = message || "";
    msgEl.style.display = message ? 'block' : 'none';

    return new Promise((resolve) => {
        btnOk.onclick = () => {
            btnOk.onclick = null;
            if (typeof dialog.close === 'function') dialog.close();
            else dialog.removeAttribute('open');
            resolve();
        };

        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
    });
}

/**
 * Layer Properties Dialog
 * @param {object} node - The layer node to edit
 * @returns {Promise<object|null>} - Resolves to the edited properties or null if cancelled
 */
export async function showLayerPropertiesDialog(node) {
    const dialog = document.getElementById('layerPropsDialog');
    if (!dialog) return null;

    const nameInput = document.getElementById('layerPropsName');
    const visibleCb = document.getElementById('layerPropsVisible');
    const ghostingCb = document.getElementById('layerPropsGhosting');
    const ghostRow = document.getElementById('layerPropsGhostRow');
    const ghostSlider = document.getElementById('layerPropsGhostOpacity');
    const ghostValSpan = document.getElementById('layerPropsGhostOpacityVal');
    const ghostBar = document.getElementById('ghostOpBar');
    const btnGhostMinus = document.getElementById('btnGhostOpMinus');
    const btnGhostPlus = document.getElementById('btnGhostOpPlus');
    const btnGhostReset = document.getElementById('btnGhostOpReset');
    const maskSelect = document.getElementById('layerPropsMaskType');
    const btnOk = document.getElementById('btnLayerPropsOk');
    const btnCancel = document.getElementById('btnLayerPropsCancel');

    // Helper to sync bar + label
    const syncGhostUI = () => {
        const v = parseInt(ghostSlider.value);
        ghostValSpan.textContent = v + '%';
        if (ghostBar) {
            const range = parseInt(ghostSlider.max) - parseInt(ghostSlider.min);
            ghostBar.style.width = ((v - parseInt(ghostSlider.min)) / range * 100) + '%';
        }
    };

    // Populate fields
    nameInput.value = node.name || '';
    visibleCb.checked = node.visible !== false;
    ghostingCb.checked = !!node.ghosting;

    const opacity = node.ghostOpacity !== undefined ? node.ghostOpacity : 50;
    ghostSlider.value = opacity;
    syncGhostUI();

    // Initial visibility of ghost row based on checkbox state
    ghostRow.style.display = ghostingCb.checked ? 'flex' : 'none';

    // Mask type
    if (node.isMask) {
        maskSelect.value = node.maskType === 'hide' ? 'hide' : 'opacity';
    } else {
        maskSelect.value = 'none';
    }

    // If clipped, disable the "None" option since unclipping must happen separately
    const noneOption = maskSelect.querySelector('option[value="none"]');
    if (node.clipped) {
        noneOption.disabled = true;
        noneOption.title = 'Unclip the layer first to remove mask';
    } else {
        noneOption.disabled = false;
        noneOption.title = '';
    }

    // Hide ghost/mask options for groups
    const isGroup = node.type === 'group';
    const titleEl = document.getElementById('layerPropsTitle');
    if (titleEl) {
        titleEl.textContent = isGroup ? 'GROUP PROPERTIES' : 'LAYER PROPERTIES';
    }
    const formContainer = dialog.querySelector('div[style*="flex-direction:column"]');
    if (formContainer) {
        const rows = formContainer.querySelectorAll(':scope > div');
        rows.forEach((row, i) => {
            // Rows: 0=Name, 1=Visible, 2=Ghost checkbox, 3=Ghost slider, 4=Mask
            if (isGroup && i >= 2) {
                row.style.display = 'none';
            } else if (i === 3) {
                // Ghost slider row: controlled by checkbox, not by generic show
                row.style.display = ghostingCb.checked ? 'flex' : 'none';
            } else {
                row.style.display = '';
            }
        });
    }

    // Live slider feedback
    const onSliderInput = () => syncGhostUI();
    ghostSlider.addEventListener('input', onSliderInput);

    // Buttons for -/+/reset (1 step normally, 5 with CTRL)
    const onMinus = (e) => {
        const step = e && e.ctrlKey ? 5 : 1;
        ghostSlider.value = Math.max(parseInt(ghostSlider.min), parseInt(ghostSlider.value) - step);
        syncGhostUI();
    };
    const onPlus = (e) => {
        const step = e && e.ctrlKey ? 5 : 1;
        ghostSlider.value = Math.min(parseInt(ghostSlider.max), parseInt(ghostSlider.value) + step);
        syncGhostUI();
    };
    const onReset = () => {
        ghostSlider.value = 50;
        syncGhostUI();
    };
    if (btnGhostMinus) btnGhostMinus.addEventListener('click', onMinus);
    if (btnGhostPlus) btnGhostPlus.addEventListener('click', onPlus);
    if (btnGhostReset) btnGhostReset.addEventListener('click', onReset);

    // Toggle ghost row visibility
    const onGhostToggle = () => {
        ghostRow.style.display = ghostingCb.checked ? 'flex' : 'none';
    };
    ghostingCb.addEventListener('change', onGhostToggle);

    // External TMP Group
    const isExtTmp = node.type === 'external_shp';
    dialog.style.minWidth = isExtTmp ? '720px' : '380px';

    if (elements.layerPropsExternalTmpGroup) {
        elements.layerPropsExternalTmpGroup.style.display = isExtTmp ? 'flex' : 'none';
        if (elements.layerPropsPreviewCol) {
            elements.layerPropsPreviewCol.style.display = isExtTmp ? 'flex' : 'none';
        }

        if (isExtTmp) {
            if (elements.layerPropsOffX) elements.layerPropsOffX.value = node.x || 0;
            if (elements.layerPropsOffY) elements.layerPropsOffY.value = node.y || 0;

            // Frame navigation state
            let lpcurrentTileIdx = node.extFrameIdx || 0;
            let lpTotalFrames = node.extTotalFrames || (node.extAllFrames ? node.extAllFrames.length : 1);

            // Setup frame controls
            const lpSlider = document.getElementById('lpExtSlider');
            const lpFrameInput = document.getElementById('lpExtFrameInput');
            const lpCounter = document.getElementById('lpExtCounter');
            const lpBtnPrev = document.getElementById('btnLpExtPrev');
            const lpBtnNext = document.getElementById('btnLpExtNext');

            const lpSyncUI = () => {
                if (lpSlider) { lpSlider.max = lpTotalFrames - 1; lpSlider.value = lpcurrentTileIdx; }
                if (lpFrameInput) lpFrameInput.value = lpcurrentTileIdx;
                if (lpCounter) lpCounter.textContent = `/ ${lpTotalFrames - 1}`;
                renderExternalTmpLayerPropsPreview(node, lpcurrentTileIdx);
            };

            const lpSetFrame = (idx) => {
                lpcurrentTileIdx = Math.max(0, Math.min(lpTotalFrames - 1, idx));
                lpSyncUI();
            };

            if (lpSlider) lpSlider.oninput = () => lpSetFrame(parseInt(lpSlider.value));
            if (lpFrameInput) lpFrameInput.oninput = () => lpSetFrame(parseInt(lpFrameInput.value) || 0);
            if (lpBtnPrev) lpBtnPrev.onclick = (e) => { e.stopPropagation(); lpSetFrame(lpcurrentTileIdx - 1); };
            if (lpBtnNext) lpBtnNext.onclick = (e) => { e.stopPropagation(); lpSetFrame(lpcurrentTileIdx + 1); };

            // Initial render
            lpSyncUI();

            const updateOffX = (val) => { elements.layerPropsOffX.value = val; };
            const updateOffY = (val) => { elements.layerPropsOffY.value = val; };

            const onOffXMinus = (e) => {
                const step = e.ctrlKey ? 5 : 1;
                updateOffX(parseInt(elements.layerPropsOffX.value) - step);
                renderExternalTmpLayerPropsPreview(node, lpcurrentTileIdx);
            };
            const onOffXPlus = (e) => {
                const step = e.ctrlKey ? 5 : 1;
                updateOffX(parseInt(elements.layerPropsOffX.value) + step);
                renderExternalTmpLayerPropsPreview(node, lpcurrentTileIdx);
            };
            const onOffYMinus = (e) => {
                const step = e.ctrlKey ? 5 : 1;
                updateOffY(parseInt(elements.layerPropsOffY.value) - step);
                renderExternalTmpLayerPropsPreview(node, lpcurrentTileIdx);
            };
            const onOffYPlus = (e) => {
                const step = e.ctrlKey ? 5 : 1;
                updateOffY(parseInt(elements.layerPropsOffY.value) + step);
                renderExternalTmpLayerPropsPreview(node, lpcurrentTileIdx);
            };

            if (elements.layerPropsOffX) elements.layerPropsOffX.oninput = () => renderExternalTmpLayerPropsPreview(node, lpcurrentTileIdx);
            if (elements.layerPropsOffY) elements.layerPropsOffY.oninput = () => renderExternalTmpLayerPropsPreview(node, lpcurrentTileIdx);
            const overlayCb = document.getElementById('lpExtShowOverlay');
            if (overlayCb) overlayCb.onchange = () => renderExternalTmpLayerPropsPreview(node, lpcurrentTileIdx);

            if (elements.btnLayerOffXMinus) elements.btnLayerOffXMinus.onclick = onOffXMinus;
            if (elements.btnLayerOffXPlus) elements.btnLayerOffXPlus.onclick = onOffXPlus;
            if (elements.btnLayerOffYMinus) elements.btnLayerOffYMinus.onclick = onOffYMinus;
            if (elements.btnLayerOffYPlus) elements.btnLayerOffYPlus.onclick = onOffYPlus;

            // Drag to move image (only if overlay is active)
            const previewCanvas = elements.layerPropsExternalPreview;
            let isDraggingPreview = false;
            let lastDragX, lastDragY;

            const onPreviewMouseDown = (e) => {
                const overlayActive = document.getElementById('lpExtShowOverlay')?.checked;
                if (!overlayActive) return;
                isDraggingPreview = true;
                lastDragX = e.clientX;
                lastDragY = e.clientY;
                previewCanvas.style.cursor = 'grabbing';
                e.preventDefault();
            };

            const onPreviewMouseMove = (e) => {
                if (!isDraggingPreview) return;
                const rect = previewCanvas.getBoundingClientRect();
                const scale = previewCanvas.width / rect.width;
                const dx = (e.clientX - lastDragX) * scale;
                const dy = (e.clientY - lastDragY) * scale;

                if (Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5) {
                    const curX = parseInt(elements.layerPropsOffX.value) || 0;
                    const curY = parseInt(elements.layerPropsOffY.value) || 0;
                    if (elements.layerPropsOffX) elements.layerPropsOffX.value = Math.round(curX + dx);
                    if (elements.layerPropsOffY) elements.layerPropsOffY.value = Math.round(curY + dy);
                    lastDragX = e.clientX;
                    lastDragY = e.clientY;
                    renderExternalTmpLayerPropsPreview(node, lpcurrentTileIdx);
                }
            };

            const onPreviewMouseUp = () => {
                if (isDraggingPreview) {
                    isDraggingPreview = false;
                    previewCanvas.style.cursor = 'grab';
                }
            };

            if (previewCanvas) {
                previewCanvas.style.cursor = 'grab';
                previewCanvas.addEventListener('mousedown', onPreviewMouseDown);
                window.addEventListener('mousemove', onPreviewMouseMove);
                window.addEventListener('mouseup', onPreviewMouseUp);
            }

            if (elements.btnLayerChangeTmp) elements.btnLayerChangeTmp.onclick = () => {
                // Re-open selector with current cached data
                openExternalTmpDialog(node.id, {
                    extFilename: node.extFilename,
                    frameIdx: lpcurrentTileIdx,
                    palette: node.extTmpPalette
                }, (data) => {
                    const { shpData, frameIdx, palette } = data;
                    const f = shpData.frames[frameIdx];

                    node.name = `Ext: ${shpData.filename} [#${frameIdx}]`;
                    nameInput.value = node.name;
                    node.extFilename = shpData.filename;
                    node.extFrameIdx = frameIdx;
                    node.extTotalFrames = shpData.frames.length;
                    node.extTmpFrameData = new Uint8Array(f.originalIndices);
                    node.extTmpPalette = palette.map(c => c ? { ...c } : null);
                    node.extWidth = f.width;
                    node.extHeight = f.height;
                    node.extFrameX = f.x;
                    node.extFrameY = f.y;
                    node.extTmpWidth = shpData.width;
                    node.extTmpHeight = shpData.height;
                    node.extAllFrames = shpData.frames;

                    lpcurrentTileIdx = frameIdx;
                    lpTotalFrames = shpData.frames.length;

                    setTimeout(() => {
                        lpSyncUI();

                        // FIX: Instantly update the main canvas & sidebar preview behind the dialog 
                        // without waiting for the user to click OK on the Layer Properties dialog
                        updateTilesList();
                        renderCanvas();
                    }, 50);
                });
            };

            // --- Promise block needs access to lpcurrentTileIdx ---
            return new Promise((resolve) => {
                const cleanup = (val) => {
                    btnOk.onclick = null;
                    btnCancel.onclick = null;
                    ghostSlider.removeEventListener('input', onSliderInput);
                    ghostingCb.removeEventListener('change', onGhostToggle);
                    if (btnGhostMinus) btnGhostMinus.removeEventListener('click', onMinus);
                    if (btnGhostPlus) btnGhostPlus.removeEventListener('click', onPlus);
                    if (btnGhostReset) btnGhostReset.removeEventListener('click', onReset);
                    if (lpSlider) lpSlider.oninput = null;
                    if (lpFrameInput) lpFrameInput.oninput = null;
                    if (lpBtnPrev) lpBtnPrev.onclick = null;
                    if (lpBtnNext) lpBtnNext.onclick = null;
                    if (previewCanvas) {
                        previewCanvas.removeEventListener('mousedown', onPreviewMouseDown);
                        previewCanvas.style.cursor = '';
                    }
                    window.removeEventListener('mousemove', onPreviewMouseMove);
                    window.removeEventListener('mouseup', onPreviewMouseUp);
                    if (typeof dialog.close === 'function') dialog.close();
                    else dialog.removeAttribute('open');
                    resolve(val);
                };

                btnOk.onclick = () => {
                    cleanup({
                        name: nameInput.value.trim() || node.name,
                        visible: visibleCb.checked,
                        ghosting: ghostingCb.checked,
                        ghostOpacity: parseInt(ghostSlider.value),
                        maskType: maskSelect.value,
                        x: parseInt(elements.layerPropsOffX.value),
                        y: parseInt(elements.layerPropsOffY.value),
                        extFrameIdx: lpcurrentTileIdx
                    });
                };

                btnCancel.onclick = () => cleanup(null);

                nameInput.onkeydown = (e) => {
                    if (e.key === 'Enter') { e.preventDefault(); btnOk.click(); }
                };

                if (typeof dialog.showModal === 'function') dialog.showModal();
                else dialog.setAttribute('open', '');

                setTimeout(() => { nameInput.focus(); nameInput.select(); }, 50);
            });
        }
    }

    return new Promise((resolve) => {
        const cleanup = (val) => {
            btnOk.onclick = null;
            btnCancel.onclick = null;
            ghostSlider.removeEventListener('input', onSliderInput);
            ghostingCb.removeEventListener('change', onGhostToggle);
            if (btnGhostMinus) btnGhostMinus.removeEventListener('click', onMinus);
            if (btnGhostPlus) btnGhostPlus.removeEventListener('click', onPlus);
            if (btnGhostReset) btnGhostReset.removeEventListener('click', onReset);
            if (typeof dialog.close === 'function') dialog.close();
            else dialog.removeAttribute('open');
            resolve(val);
        };

        btnOk.onclick = () => {
            cleanup({
                name: nameInput.value.trim() || node.name,
                visible: visibleCb.checked,
                ghosting: ghostingCb.checked,
                ghostOpacity: parseInt(ghostSlider.value),
                maskType: maskSelect.value,
                x: isExtTmp ? parseInt(elements.layerPropsOffX.value) : node.x,
                y: isExtTmp ? parseInt(elements.layerPropsOffY.value) : node.y
            });
        };

        btnCancel.onclick = () => cleanup(null);

        // Enter key submits
        nameInput.onkeydown = (e) => {
            if (e.key === 'Enter') { e.preventDefault(); btnOk.click(); }
        };

        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');

        // Focus the name field and select all text
        setTimeout(() => { nameInput.focus(); nameInput.select(); }, 50);
    });
}

/**
 * Render External TMP preview for Layer Properties
 * @param {Object} node - The layer node
 * @param {Number} frameIdx - Frame index to render (defaults to node.extFrameIdx)
 */
function renderExternalTmpLayerPropsPreview(node, frameIdx) {
    if (!node || node.type !== 'external_shp' || !node.extTmpPalette) return;
    const canvas = elements.layerPropsExternalPreview;
    const info = elements.layerPropsExternalInfo;
    const bgContainer = document.getElementById('layerPropsPreviewBg');
    if (!canvas) return;

    if (frameIdx === undefined) frameIdx = node.extFrameIdx || 0;

    // Get frame data: either from extAllFrames or from stored single frame
    let fw, fh, fx, fy, indices;
    if (node.extAllFrames && node.extAllFrames[frameIdx]) {
        const f = node.extAllFrames[frameIdx];
        fw = f.width; fh = f.height; fx = f.x || 0; fy = f.y || 0;
        indices = f.originalIndices;
    } else {
        fw = node.extWidth; fh = node.extHeight;
        fx = node.extFrameX || 0; fy = node.extFrameY || 0;
        indices = node.extTmpFrameData;
    }
    if (!indices) return;

    const ctx = canvas.getContext('2d');
    const shpW = node.extTmpWidth || node.extWidth;
    const shpH = node.extTmpHeight || node.extHeight;
    canvas.width = shpW;
    canvas.height = shpH;

    // Set background color from palette index 0
    const bg = node.extTmpPalette[0] || { r: 0, g: 0, b: 0 };
    const bgColor = `rgb(${bg.r},${bg.g},${bg.b})`;
    if (bgContainer) bgContainer.style.background = bgColor;

    // Build an off-screen canvas for the external TMP
    const extCanvas = document.createElement('canvas');
    extCanvas.width = shpW;
    extCanvas.height = shpH;
    const extCtx = extCanvas.getContext('2d');
    const extD = extCtx.createImageData(shpW, shpH);
    const extData = extD.data;

    for (let y = 0; y < fh; y++) {
        const py = fy + y;
        if (py < 0 || py >= shpH) continue;
        for (let x = 0; x < fw; x++) {
            const px = fx + x;
            if (px < 0 || px >= shpW) continue;
            const idx = indices[y * fw + x];
            if (idx === 0 || idx === TRANSPARENT_COLOR) continue;
            const c = node.extTmpPalette[idx];
            const target = (py * shpW + px) * 4;
            if (c) {
                extData[target] = c.r; extData[target + 1] = c.g; extData[target + 2] = c.b; extData[target + 3] = 255;
            }
        }
    }
    extCtx.putImageData(extD, 0, 0);

    const cbOverlay = document.getElementById('lpExtShowOverlay');
    const isOverlayOn = cbOverlay && cbOverlay.checked && state.tiles[state.currentTileIdx];

    const cxInput = document.getElementById('layerPropsOffX');
    const cyInput = document.getElementById('layerPropsOffY');
    const cx = cxInput ? parseInt(cxInput.value) || 0 : node.x || 0;
    const cy = cyInput ? parseInt(cyInput.value) || 0 : node.y || 0;

    if (isOverlayOn) {
        const mainFrame = state.tiles[state.currentTileIdx];
        const mainW = mainFrame.width || state.tiles[0].width;
        const mainH = mainFrame.height || state.tiles[0].height;

        const compositeResult = window.compositeFrame(mainFrame, {
            transparentIdx: TRANSPARENT_COLOR,
            includeExternalTmp: true,
            excludeNodeId: node.id
        });

        // Compute bounding box logic so the graphic isn't cut off when moved outside main frame bounds
        const originX = Math.round(mainW / 2 - shpW / 2);
        const originY = Math.round(mainH / 2 - shpH / 2);
        const targetX = originX + cx;
        const targetY = originY + cy;

        const minX = Math.min(0, targetX);
        const minY = Math.min(0, targetY);
        const maxX = Math.max(mainW, targetX + shpW);
        const maxY = Math.max(mainH, targetY + shpH);

        // Symmetric expansion ensures the main TMP remains dead-center in the flex container
        const maxExpandX = Math.max(0, -minX, maxX - mainW);
        const maxExpandY = Math.max(0, -minY, maxY - mainH);

        const pad = 10;
        canvas.width = mainW + maxExpandX * 2 + pad * 2;
        canvas.height = mainH + maxExpandY * 2 + pad * 2;

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const mainCanv = document.createElement('canvas');
        mainCanv.width = mainW;
        mainCanv.height = mainH;
        const mCtx = mainCanv.getContext('2d');
        const mData = mCtx.createImageData(mainW, mainH);

        for (let k = 0; k < compositeResult.length; k++) {
            const v = compositeResult[k];
            if (v !== TRANSPARENT_COLOR && v !== 0) {
                const c = state.palette[v];
                if (c) {
                    const off = k * 4;
                    mData.data[off] = c.r; mData.data[off + 1] = c.g; mData.data[off + 2] = c.b; mData.data[off + 3] = 255;
                }
            }
        }
        mCtx.putImageData(mData, 0, 0);

        const drawOffX = maxExpandX + pad;
        const drawOffY = maxExpandY + pad;

        ctx.drawImage(mainCanv, drawOffX, drawOffY);

        // Draw the frame limits of the main TMP
        ctx.strokeStyle = "rgba(0, 255, 170, 0.5)";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(drawOffX - 0.5, drawOffY - 0.5, mainW + 1, mainH + 1);
        ctx.setLineDash([]);

        ctx.drawImage(extCanvas, drawOffX + targetX, drawOffY + targetY);

    } else {
        // Just the external TMP
        canvas.width = shpW;
        canvas.height = shpH;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        ctx.drawImage(extCanvas, 0, 0);
    }

    if (info) {
        info.innerText = `${node.extFilename || 'External TMP'}\n${shpW}x${shpH}`;
    }
}

/**
 * Custom Confirmation Dialog
 */
import { t } from './translations.js';

export async function showConfirm(title, message = "") {
    const dialog = document.getElementById('confirmDialog');
    const msgEl = document.getElementById('confirmMessage');
    const titleEl = document.getElementById('confirmTitle');
    const btnYes = document.getElementById('btnConfirmYes');
    const btnNo = document.getElementById('btnConfirmNo');

    if (!dialog || !msgEl || !btnYes || !btnNo) {
        return confirm(message ? `${title}\n\n${message}` : title);
    }

    // Correctly process title and message based on usage
    let finalTitle = title;
    let finalMsg = message;

    // IF ONLY ONE PARAMETER PASSED, IT IS THE MESSAGE (Body)
    // AND THE TITLE IS THE GENERIC Header
    if (title && !message) {
        finalTitle = t('dlg_confirm_title') || "CONFIRM ACTION";
        finalMsg = title;
    } else {
        // Both provided? Translate title if it looks like a key, otherwise leave same
        finalTitle = (t(title) !== title) ? t(title) : (title || t('dlg_confirm_title') || "CONFIRM ACTION");
    }

    // Try translating body MESSAGE as well
    if (finalMsg && t(finalMsg) !== finalMsg) {
        finalMsg = t(finalMsg);
    }

    titleEl.textContent = finalTitle;
    msgEl.innerHTML = finalMsg || ""; 
    msgEl.style.display = finalMsg ? 'block' : 'none';

    btnYes.textContent = t('btn_yes') || "YES";
    btnNo.textContent = t('btn_no') || "NO";

    return new Promise((resolve) => {
        const cleanup = (val) => {
            btnYes.onclick = null;
            btnNo.onclick = null;
            if (typeof dialog.close === 'function') dialog.close();
            else dialog.removeAttribute('open');
            resolve(val);
        };

        btnYes.onclick = () => cleanup(true);
        btnNo.onclick = () => cleanup(false);

        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
    });
}


/**
 * Custom Choice Dialog (3 options: btn1, btn2, cancel)
 */
export async function showChoice(title, message, label1, label2) {
    const dialog = document.getElementById('choiceDialog');
    const msgEl = document.getElementById('choiceMessage');
    const titleEl = document.getElementById('choiceTitle');
    const btn1 = document.getElementById('btnChoice1');
    const btn2 = document.getElementById('btnChoice2');
    const btnCancel = document.getElementById('btnChoiceCancel');

    if (!dialog || !msgEl || !btn1 || !btn2 || !btnCancel) {
        // Fallback to confirm-like behavior or just fail gracefully
        const res = confirm(`${title}\n\n${message}\n\nOK for ${label1}, Cancel for ${label2}`);
        return res ? 'opt1' : 'opt2';
    }

    titleEl.textContent = title;
    msgEl.innerHTML = message || "";
    btn1.textContent = label1;
    btn2.textContent = label2;

    return new Promise((resolve) => {
        const cleanup = (val) => {
            btn1.onclick = null;
            btn2.onclick = null;
            btnCancel.onclick = null;
            if (typeof dialog.close === 'function') dialog.close();
            else dialog.removeAttribute('open');
            resolve(val);
        };

        btn1.onclick = () => cleanup('opt1');
        btn2.onclick = () => cleanup('opt2');
        btnCancel.onclick = () => cleanup('cancel');

        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');

        // Focus the first button by default
        setTimeout(() => btn1.focus(), 0);
    });
}

export function createNewProject(w, h, palette = null, compression = 3, solidStart = true) {
    state.canvasW = w;
    state.canvasH = h;
    state.compression = compression;

    if (palette) {
        state.palette = palette;
    }

    state.tiles = [];
    addTile(w, h);

    const f = state.tiles[0];
    if (f && f.data) {
        f.data.fill(solidStart ? 0 : TRANSPARENT_COLOR);
    }
    updateUIState();

    state.currentTileIdx = 0;
    state.subSelection.clear();
    state.currentTileKey = null;
    resetFramesList();
    // Initialize activeTileId if needed, but for TMP we just have currentTileIdx
    state.activeLayerId = null;
    state.history = [];
    state.historyPtr = -1;
    state.selection = null;
    state.floatingSelection = null;
    state.zoom = 1;

    updateCanvasSize();
    pushHistory('all', true);
    renderCanvas();
    updateTilesList();
    renderPalette(); // Main palette UI
    updateTilesList();

    // Update UI visibility based on project state
    if (typeof updateUIState === 'function') {
        updateUIState();
    }
    updateTileProperties();
}

export function addTile(w, h, data) {
    if (!w || typeof w !== 'number') w = state.cx || (state.gameType === 'ts' ? 48 : 60);
    if (!h || typeof h !== 'number') h = state.cy || (state.gameType === 'ts' ? 24 : 30);
    const newTile = {
        id: generateId(),
        width: w,
        height: h,
        data: data ? new Uint8Array(data) : new Uint8Array(w * h).fill(TRANSPARENT_COLOR),
        zData: TmpTsFile.decodeTileDiamond(TmpTsFile.generateDefaultZData(w, h), w, h),
        tileHeader: {
            x: 0, y: 0, height: 0, land_type: 0, ramp_type: 0, flags: 2,
            has_extra_data: false, has_z_data: true, has_damaged_data: false,
            radar_red_left: 128, radar_green_left: 128, radar_blue_left: 128,
            radar_red_right: 128, radar_green_right: 128, radar_blue_right: 128
        },
        visible: true,
        _v: 0
    };

    // Insert after current tile index
    const insertIdx = state.currentTileIdx + 1;
    state.tiles.splice(insertIdx, 0, newTile);
    state.currentTileIdx = insertIdx;
    state.tileSelection.clear();
    state.tileSelection.add(insertIdx);
    state.subSelection.clear();
    state.currentTileKey = `${insertIdx}_base`;
    state.subSelection.add(state.currentTileKey);

    updateTilesList();
    renderCanvas();
    renderPalette();
    pushHistory();
    if (typeof updateUIState === 'function') updateUIState();
    updateTileProperties();
    updateExtraBtnState();
}














export function getContrastYIQ(r, g, b) {
    if (r === undefined || g === undefined || b === undefined) return '#000';
    var yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
    return (yiq >= 128) ? '#000000' : '#ffffff';
}

export function updateToolSettingsUI(tool) {
    if (elements.propSelectionModes) elements.propSelectionModes.style.display = 'none';

    const propWandOptions = document.getElementById('prop-wand-options');
    if (propWandOptions) propWandOptions.style.display = 'none';

    const propMovePixels = document.getElementById('prop-movePixels');
    if (propMovePixels) propMovePixels.style.display = 'none';

    if (['select', 'lasso', 'wand'].includes(tool)) {
        if (elements.propSelectionModes) elements.propSelectionModes.style.display = 'block';
    }

    if (tool === 'wand') {
        if (propWandOptions) propWandOptions.style.display = 'block';
    }

    if (tool === 'movePixels') {
        if (propMovePixels) propMovePixels.style.display = 'block';
    }

    if (elements.propColorShift) elements.propColorShift.style.display = 'none';

    if (tool === 'colorShift') {
        if (elements.propColorShift) elements.propColorShift.style.display = 'block';
    }
}

export function triggerSelectionFlash() {
    const wasAnimating = state.selectionFlash > 0;
    state.selectionFlash = 0.8;
    if (wasAnimating) return;

    function animate() {
        if (state.selectionFlash > 0) {
            state.selectionFlash -= 0.05;
            if (state.selectionFlash < 0) state.selectionFlash = 0;
            renderOverlay();
            requestAnimationFrame(animate);

        }
    }
    animate();
}

/**
 * UI State Sync */

export function toggleMoveMode() {
    state.moveMode = !state.moveMode;
    if (elements.btnMoveMode) {
        elements.btnMoveMode.classList.toggle('active', state.moveMode);
        elements.btnMoveMode.style.backgroundColor = state.moveMode ? 'var(--accent)' : '';
        elements.btnMoveMode.style.color = state.moveMode ? '#000' : '';
    }
}

if (elements.btnMoveMode) elements.btnMoveMode.onclick = () => toggleMoveMode();

window.addEventListener('keydown', (e) => {
    if (!e.key) return;
    const k = e.key.toLowerCase();
    const isArrow = ['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(k);
    if (!isArrow) return;

    // Only move if Move Mode is active, we have a selection, and NOT typing in an input
    const isInputFocused = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
    if (state.moveMode && state.tileSelection.size > 0 && !isInputFocused) {
        let dx = 0, dy = 0;
        const step = e.ctrlKey ? (state.cx === 48 ? 4 : 5) : 1;
        if (k === 'arrowleft')  dx = -step;
        if (k === 'arrowright') dx = step;
        if (k === 'arrowup')    dy = -step;
        if (k === 'arrowdown')  dy = step;
        
        if (dx !== 0 || dy !== 0) {
            e.preventDefault();
            
            // Record history for EVERY press/repeat as explicitly requested
            moveSelectedTilesPixels(dx, dy); 
        }
    }
});

/**
 * Returns the currently selected tile in state.
 */
export function getActiveTile() {
    return state.tiles[state.currentTileIdx] || null;
}

export async function deleteTile(bypassConfirm = false) {
    if (state.tiles.length <= 1) return;

    if (!bypassConfirm) {
        const confirmed = await showConfirm("msg_confirm_delete_tile");
        if (!confirmed) return;
    }

    pushHistory();
    state.tiles.splice(state.currentTileIdx, 1);
    state.currentTileIdx = Math.max(0, state.currentTileIdx - 1);

    updateTilesList();
    renderCanvas();
    updateTilesList();
}

export function duplicateTile() {
    const tile = getActiveTile();
    if (!tile) return;

    pushHistory();
    const newTile = {
        ...tile,
        id: generateId(),
        data: new Uint8Array(tile.data),
        _v: (tile._v || 0) + 1
    };
    if (tile.tileHeader) newTile.tileHeader = { ...tile.tileHeader };

    state.tiles.splice(state.currentTileIdx + 1, 0, newTile);
    state.currentTileIdx++;

    updateTilesList();
    renderCanvas();
}

export function selectPreviousTile() {
    const populatedTiles = state.tiles
        .map((tile, originalIdx) => ({ tile, originalIdx }))
        .filter(item => item.tile && item.tile.tileHeader !== null);

    const currentVisualIdx = populatedTiles.findIndex(p => p.originalIdx === state.currentTileIdx);
    if (currentVisualIdx > 0) {
        state.currentTileIdx = populatedTiles[currentVisualIdx - 1].originalIdx;
        updateTilesList();
        renderCanvas();

        // Ensure the newly selected tile is visible in the scroll list
        const list = elements.tilesList;
        if (list) {
            const visualIdx = currentVisualIdx - 1;
            const itemTop = visualIdx * TILE_ITEM_HEIGHT;
            if (itemTop < list.scrollTop) {
                list.scrollTop = itemTop;
            } else if (itemTop + TILE_ITEM_HEIGHT > list.scrollTop + list.clientHeight) {
                list.scrollTop = itemTop + TILE_ITEM_HEIGHT - list.clientHeight;
            }
        }
    }
}

export function selectNextTile() {
    const populatedTiles = state.tiles
        .map((tile, originalIdx) => ({ tile, originalIdx }))
        .filter(item => item.tile && item.tile.tileHeader !== null);

    const currentVisualIdx = populatedTiles.findIndex(p => p.originalIdx === state.currentTileIdx);
    if (currentVisualIdx !== -1 && currentVisualIdx < populatedTiles.length - 1) {
        state.currentTileIdx = populatedTiles[currentVisualIdx + 1].originalIdx;
        updateTilesList();
        renderCanvas();

        // Ensure visible
        const list = elements.tilesList;
        if (list) {
            const visualIdx = currentVisualIdx + 1;
            const itemTop = visualIdx * TILE_ITEM_HEIGHT;
            if (itemTop < list.scrollTop) {
                list.scrollTop = itemTop;
            } else if (itemTop + TILE_ITEM_HEIGHT > list.scrollTop + list.clientHeight) {
                list.scrollTop = itemTop + TILE_ITEM_HEIGHT - list.clientHeight;
            }
        }
    }
}

export function updateActiveTilePreview() {
    const tile = getActiveTile();
    if (!tile) return;

    const canvas = document.getElementById(`layer-preview-${tile.id}`);
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    renderTileThumbnail(tile, ctx, canvas.width, canvas.height, true);

    state.tiles[state.currentTileIdx]._v = (tile._v || 0) + 1;
    updateTilesList();
}

export function copySelection() {
    const tile = getActiveTile();
    if (!tile || !tile.visible) return;

    // Use snapshot helper to handle tiles
    let dataSource = getTileDataSnapshot(tile);
    if (!dataSource) return;

    let w = 0, h = 0, data = null, x = 0, y = 0;

    if (state.selection) {
        x = state.selection.x;
        y = state.selection.y;
        w = state.selection.w;
        h = state.selection.h;
        data = new Uint8Array(w * h);
        data.fill(TRANSPARENT_COLOR);



        // Helper to safely read
        const safeRead = (reqX, reqY) => {
            if (reqX >= 0 && reqX < state.canvasW && reqY >= 0 && reqY < state.canvasH) {
                return dataSource[reqY * state.canvasW + reqX];
            }
            return TRANSPARENT_COLOR;
        };

        if (state.selection.type === 'rect') {
            for (let sy = 0; sy < h; sy++) {
                for (let sx = 0; sx < w; sx++) {
                    data[sy * w + sx] = safeRead(x + sx, y + sy);
                }
            }
        } else if (state.selection.type === 'mask') {
            for (let sy = 0; sy < h; sy++) {
                for (let sx = 0; sx < w; sx++) {
                    if (state.selection.maskData[sy * w + sx]) {
                        data[sy * w + sx] = safeRead(x + sx, y + sy);
                    }
                }
            }
        } else {
            // Fallback
            for (let sy = 0; sy < h; sy++) {
                for (let sx = 0; sx < w; sx++) {
                    data[sy * w + sx] = safeRead(x + sx, y + sy);
                }
            }
        }
    } else {
        // Copy whole layer - use snapshot for consistency (esp. for external TMP)
        x = 0; y = 0;
        w = state.canvasW; h = state.canvasH;
        data = new Uint8Array(dataSource);
    }

    state.clipboard = {
        w, h, data, x, y,
        type: state.selection ? state.selection.type : 'rect',
        maskData: (state.selection && state.selection.maskData) ? new Uint8Array(state.selection.maskData) : null
    };
    console.log("Copied to clipboard", w, h);
    triggerSelectionFlash();

    // Export to system clipboard as PNG
    exportToSystemClipboard(data, w, h);
}

/**
 * Exports image data to the system clipboard as a PNG
 */
export async function exportToSystemClipboard(indices, width, height) {
    try {
        // Create a temporary canvas to render the image
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');

        // Create ImageData from palette indices
        const imageData = ctx.createImageData(width, height);
        for (let i = 0; i < indices.length; i++) {
            const paletteIdx = indices[i];
            const color = state.palette[paletteIdx] || { r: 0, g: 0, b: 0 };
            const offset = i * 4;
            imageData.data[offset] = color.r;
            imageData.data[offset + 1] = color.g;
            imageData.data[offset + 2] = color.b;
            imageData.data[offset + 3] = (paletteIdx === TRANSPARENT_COLOR) ? 0 : 255;
        }
        ctx.putImageData(imageData, 0, 0);
        
        // Convert canvas to blob and write to clipboard using the robust Promise pattern
        try {
            const blobPromise = new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
            const item = new ClipboardItem({ "image/png": blobPromise });
            await navigator.clipboard.write([item]);
            console.log('Image copied to system clipboard (SHP Style)');
        } catch (err) {
            console.warn('Failed to write to system clipboard:', err);
            // Fallback for file:// context in copySelection
            const dataUrl = canvas.toDataURL('image/png');
            showImageCopyFallback(dataUrl, 'Selection');
        }
    } catch (err) {
        console.warn('Failed to export to system clipboard:', err);
    }
}

export function cutSelection() {
    copySelection();      // Save to clipboard first
    deleteSelection();    // Clear selection pixels and push history
}

export function pasteClipboard(newTileRequested = true) {
    if (!state.clipboard) return;
    const { w, h, data } = state.clipboard;
    let px = state.clipboard.x || 0;
    let py = state.clipboard.y || 0;

    // Commit any in-progress floating selection silently (its own pushHistory already done)
    if (state.floatingSelection) commitSelection();

    if (newTileRequested) {
        // Create tile directly
        addTile(state.canvasW, state.canvasH);
    }

    const targetTile = getActiveTile();
    if (!targetTile) return;

    const cType = state.clipboard.type || 'rect';
    const cMaskData = state.clipboard.maskData ? new Uint8Array(state.clipboard.maskData) : null;

    state.floatingSelection = {
        frameIdx: state.currentTileIdx,
        x: px,
        y: py,
        w: w,
        h: h,
        data: new Uint8Array(data), // Clone to avoid mutation of clipboard
        "tt_game_grid": "Show Game-specific Alignment Grid",
        "sidebar_tiles": "CELLS",
        "sidebar_palette": "PALETTE",
        originalData: new Uint8Array(data),
        originalW: w,
        originalH: h,
        type: cType,
        maskData: cMaskData,
        originalMaskData: cMaskData ? new Uint8Array(cMaskData) : null,
        targetLayerId: targetTile.id
    };

    state.selection = {
        type: cType,
        x: px,
        y: py,
        w: w,
        h: h,
        maskData: cMaskData
    };

    // Save state AFTER paste to store the added floating selection
    pushHistory();

    startAnts();
    renderCanvas();
    updateTilesList();
    updateTilesList();
    renderOverlay();
    triggerSelectionFlash();
}

/**
 * Pastes clipboard content into a completely new frame
 */
export function pasteAsNewFrame() {
    if (!state.clipboard) return;

    // Add a new frame with current project dimensions
    addTile(state.canvasW, state.canvasH);

    // Paste into the newly created frame's active layer (which is "Layer 1")
    pasteClipboard(false);
}

export function selectAll() {
    state.selection = {
        type: 'rect',
        x: 0, y: 0,
        w: state.canvasW, h: state.canvasH
    };
    startAnts();
    renderOverlay();
    triggerSelectionFlash();
    if (typeof updateUIState === 'function') updateUIState();
}

export function invertSelection() {
    if (!state.selection) {
        selectAll();
        return;
    }
    const w = state.canvasW;
    const h = state.canvasH;
    const newMask = new Uint8Array(w * h).fill(1); // Default all selected

    if (state.selection.type === 'rect') {
        const s = state.selection;
        for (let y = s.y; y < s.y + s.h; y++) {
            for (let x = s.x; x < s.x + s.w; x++) {
                if (x >= 0 && x < w && y >= 0 && y < h) newMask[y * w + x] = 0;
            }
        }
    } else if (state.selection.type === 'mask') {
        const s = state.selection;
        for (let y = 0; y < s.h; y++) {
            for (let x = 0; x < s.w; x++) {
                if (s.maskData[y * s.w + x]) {
                    const tx = s.x + x;
                    const ty = s.y + y;
                    if (tx >= 0 && tx < w && ty >= 0 && ty < h) newMask[ty * w + tx] = 0;
                }
            }
        }
    }
    // Check if the new mask is empty (all 0)
    const isEmpty = !newMask.some(v => v === 1);
    if (isEmpty) {
        deselect();
        return;
    }

    state.selection = {
        type: 'mask',
        x: 0, y: 0, w, h,
        maskData: newMask
    };
    renderOverlay();
    triggerSelectionFlash();
    if (typeof updateUIState === 'function') updateUIState();
}

export function togglePixelSelection(x, y) {
    if (!state.selection) {
        // Create a minimal 1x1 selection at the clicked pixel
        state.selection = {
            type: 'mask',
            x: x, y: y, w: 1, h: 1,
            maskData: new Uint8Array(1).fill(1)
        };
    } else {
        // Convert rect to mask if needed
        if (state.selection.type === 'rect') {
            const s = state.selection;
            const mask = new Uint8Array(s.w * s.h).fill(1);
            state.selection = {
                type: 'mask',
                x: s.x, y: s.y, w: s.w, h: s.h,
                maskData: mask
            };
        }

        // Toggle the pixel
        const s = state.selection;

        // Check if pixel is within current selection bounds
        if (x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h) {
            // Pixel is within bounds, toggle it
            const localX = x - s.x;
            const localY = y - s.y;
            const idx = localY * s.w + localX;
            const oldValue = s.maskData[idx];
            s.maskData[idx] = oldValue ? 0 : 1;
        } else {
            // Pixel is outside bounds, need to expand the mask
            const newMinX = Math.min(s.x, x);
            const newMinY = Math.min(s.y, y);
            const newMaxX = Math.max(s.x + s.w - 1, x);
            const newMaxY = Math.max(s.y + s.h - 1, y);
            const newW = newMaxX - newMinX + 1;
            const newH = newMaxY - newMinY + 1;

            const newMask = new Uint8Array(newW * newH).fill(0);

            // Copy old mask data
            for (let sy = 0; sy < s.h; sy++) {
                for (let sx = 0; sx < s.w; sx++) {
                    if (s.maskData[sy * s.w + sx]) {
                        const newX = (s.x + sx) - newMinX;
                        const newY = (s.y + sy) - newMinY;
                        newMask[newY * newW + newX] = 1;
                    }
                }
            }

            // Set the new pixel
            const newX = x - newMinX;
            const newY = y - newMinY;
            newMask[newY * newW + newX] = 1;

            state.selection = {
                type: 'mask',
                x: newMinX, y: newMinY, w: newW, h: newH,
                maskData: newMask
            };
        }
    }
    renderOverlay();
}


export function startMovingSelectionPixels() {
    if (!state.selection) return;
    if (state.floatingSelection) return; // Already floating

    const tile = getActiveTile();
    if (!tile || !tile.visible) return;

    pushHistory();

    const s = state.selection;
    const w = s.w;
    const h = s.h;

    // Extract pixel data from layer
    const floatingData = new Uint8Array(w * h).fill(TRANSPARENT_COLOR);

    if (s.type === 'rect') {
        // Extract rectangle
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const lx = s.x + x;
                const ly = s.y + y;
                if (lx >= 0 && lx < tile.width && ly >= 0 && ly < tile.height) {
                    const idx = ly * tile.width + lx;
                    floatingData[y * w + x] = tile.data[idx];
                    tile.data[idx] = TRANSPARENT_COLOR; // Clear original pixel (Void)
                }
            }
        }

        state.floatingSelection = {
            frameIdx: state.currentTileIdx,
            x: s.x,
            y: s.y,
            w: w,
            h: h,
            data: floatingData,
            originalData: new Uint8Array(floatingData),
            originalW: w,
            originalH: h,
            type: 'rect',
            targetLayerId: tile.id
        };
    } else if (s.type === 'mask') {
        // Extract masked pixels
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                if (s.maskData[y * w + x]) {
                    const lx = s.x + x;
                    const ly = s.y + y;
                    if (lx >= 0 && lx < tile.width && ly >= 0 && ly < tile.height) {
                        const idx = ly * tile.width + lx;
                        floatingData[y * w + x] = tile.data[idx];
                        tile.data[idx] = TRANSPARENT_COLOR; // Clear original pixel (Void)
                    }
                }
            }
        }

        state.floatingSelection = {
            frameIdx: state.currentTileIdx,
            x: s.x,
            y: s.y,
            w: w,
            h: h,
            data: floatingData,
            originalData: new Uint8Array(floatingData),
            originalW: w,
            originalH: h,
            maskData: s.maskData, // Keep mask for rendering
            originalMaskData: s.maskData ? new Uint8Array(s.maskData) : null,
            type: 'mask',
            targetLayerId: tile.id
        };
    }

    renderCanvas();
    updateTilesList();
    updateTilesList();
}

export function finishMovingSelectionPixels() {
    commitSelection();
}


export function commitSelection() {
    if (!state.floatingSelection) return;
    const tile = getActiveTile();
    if (!tile) return;

    const f = state.floatingSelection;
    const minX = state.worldBounds.minX;
    const minY = state.worldBounds.minY;

    // Relative to the Project top-left
    const lxOffset = Math.round(tile.itemMinX - minX);
    const lyOffset = Math.round(tile.itemMinY - minY);

    // Merge floating pixels back to tile components
    const fsW = f.w || f.width;
    const fsH = f.h || f.height;

    for (let y = 0; y < fsH; y++) {
        for (let x = 0; x < fsW; x++) {
            if (f.maskData && !f.maskData[y * fsW + x]) continue;

            const val = f.data[y * fsW + x];
            if (val !== TRANSPARENT_COLOR) {
                const tx = f.x + x;
                const ty = f.y + y;
                
                // Absolute project coordinate to local tile bounds
                const locX = tx - lxOffset;
                const locY = ty - lyOffset;

                // 1. Diamond Base
                const bDx = Math.round(locX - tile.diamondX);
                const bDy = Math.round(locY - tile.diamondY);
                if (bDx >= 0 && bDx < state.cx && bDy >= 0 && bDy < state.cy) {
                    tile.data[bDy * state.cx + bDx] = val;
                }

                // 2. Extra Data Rect
                if (tile.tileHeader && tile.tileHeader.has_extra_data && tile.extraImageData) {
                    const exX = Math.round(locX - tile.extraX);
                    const exY = Math.round(locY - tile.extraY);
                    if (exX >= 0 && exX < tile.tileHeader.cx_extra && exY >= 0 && exY < tile.tileHeader.cy_extra) {
                        tile.extraImageData[exY * tile.tileHeader.cx_extra + exX] = val;
                    }
                }
            }
        }
    }

    state.floatingSelection = null;
    state.isMovingSelection = false;

    pushHistory();
    renderCanvas();
    updateTilesList();
}

export function clearSelection(commit = true) {
    if (commit) commitSelection();
    // If not committing, we discard floating pixels (Undo behavior?)
    // Typically clearSelection() implies committing unless specified.

    state.selection = null;
    state.floatingSelection = null; // Just in case
    renderCanvas();
    renderOverlay();
}

export function checkIfPixelSelected(x, y, selection) {
    if (!selection) return false;

    if (selection.type === 'rect') {
        return x >= selection.x && x < selection.x + selection.w &&
            y >= selection.y && y < selection.y + selection.h;
    } else if (selection.type === 'mask') {
        // Check if pixel is within mask bounds
        if (x < selection.x || x >= selection.x + selection.w ||
            y < selection.y || y >= selection.y + selection.h) {
            return false;
        }
        // Check mask data
        const localX = x - selection.x;
        const localY = y - selection.y;
        return selection.maskData[localY * selection.w + localX] === 1;
    }

    return false;
}

export function combineSelection(oldSel, newSel, mode) {
    const w = state.canvasW;
    const h = state.canvasH;

    // Helper to get pixel value (0 or 1) from ANY selection type
    const getVal = (s, x, y) => {
        if (!s) return 0;
        if (s.type === 'rect') {
            return (x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h) ? 1 : 0;
        } else if (s.type === 'mask') {
            // Handle Global vs Local mask
            if (s.maskData.length === w * h) {
                // Global Mask
                return s.maskData[y * w + x] ? 1 : 0;
            } else {
                // Local Mask (relative to s.x, s.y)
                const lx = x - s.x;
                const ly = y - s.y;
                if (lx >= 0 && lx < s.w && ly >= 0 && ly < s.h) {
                    return s.maskData[ly * s.w + lx] ? 1 : 0;
                }
            }
            return 0;
        }
        return 0;
    };

    // 1. Perform Global Operation & Find Bounds
    let minX = w, maxX = -1, minY = h, maxY = -1;
    const tempGlobal = new Uint8Array(w * h); // Temporarily store result globally because we need 2 passes (one to find bounds, one to copy)

    let pixelCount = 0;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const v1 = getVal(oldSel, x, y);
            const v2 = getVal(newSel, x, y);



            let res = 0;
            if (mode === 'add') res = v1 | v2;
            else if (mode === 'sub') res = v1 & (!v2);
            else if (mode === 'int') res = v1 & v2;
            else if (mode === 'xor') res = v1 ^ v2;

            if (res) {
                tempGlobal[y * w + x] = 1;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
                pixelCount++;
            }
        }
    }



    // 2. Create Result
    if (maxX === -1) {
        return null;
    } else {
        const nw = maxX - minX + 1;
        const nh = maxY - minY + 1;
        const localMask = new Uint8Array(nw * nh);

        // Copy cropped area
        for (let fy = 0; fy < nh; fy++) {
            for (let fx = 0; fx < nw; fx++) {
                if (tempGlobal[(minY + fy) * w + (minX + fx)]) {
                    localMask[fy * nw + fx] = 1;
                }
            }
        }

        const result = {
            type: 'mask',
            x: minX, y: minY, w: nw, h: nh,
            maskData: localMask
        };

        return result;
    }
}

export function updateModeButtons() {
    const mode = state.selectionMode || 'new';
    if (elements.btnSelNew) elements.btnSelNew.classList.toggle('active', mode === 'new');
    if (elements.btnSelAdd) elements.btnSelAdd.classList.toggle('active', mode === 'add');
    if (elements.btnSelSub) elements.btnSelSub.classList.toggle('active', mode === 'sub');
    if (elements.btnSelInt) elements.btnSelInt.classList.toggle('active', mode === 'int');
    if (elements.btnSelXor) elements.btnSelXor.classList.toggle('active', mode === 'xor');
}

// --- DRAG AND DROP HANDLER ---


export function initPanelResizing() {

    // Bottom Table Resizer
    const resizerBottom = elements.tileDataTableResizer;
    const panelBottom = elements.tileDataTablePanel;
    if (resizerBottom && panelBottom) {
        let isResizing = false;
        resizerBottom.onmousedown = (e) => {
            isResizing = true;
            resizerBottom.style.background = 'var(--accent)';
            document.body.style.cursor = 'ns-resize';
            document.body.style.userSelect = 'none';
            e.preventDefault();
        };
        window.addEventListener('mousemove', (e) => {
            if (isResizing) {
                const viewportHeight = window.innerHeight;
                // panel is above statusBar
                const statusBarH = elements.statusBar ? elements.statusBar.offsetHeight : 25;
                const newHeight = viewportHeight - e.clientY - statusBarH; 
                const finalHeight = Math.min(800, Math.max(80, newHeight));
                panelBottom.style.height = finalHeight + 'px';
            }
        });
        window.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                resizerBottom.style.background = '#333';
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            }
        });
    }
}

export function showEditorInterface() {
    if (elements.panelLeft) elements.panelLeft.style.display = 'flex';
    if (elements.panelRight) elements.panelRight.style.display = 'flex';

    // Force layout update
    initPanelResizing();
}



// --- Composite Data Cache for Thumbnails ---
const _compositeCache = new WeakMap();

function _getCachedComposite(frame, options = {}) {
    const isCurrentFrame = state.tiles[state.currentTileIdx] === frame;
    // Cache key must include all factors that affect the composite output
    const cacheKey = `${frame._v || 0}_${frame.width}_${frame.height}_${state.paletteVersion}_${options.showIndex0 !== undefined ? options.showIndex0 : false}_${options.showOnlyBackground || false}_${isCurrentFrame && state.floatingSelection ? 'fs' : 'nofs'}_${options.includeExternalTmp ? 'ext' : 'noext'}_${state.flatCells ? 'flat' : 'elevated'}`;

    let entry = _compositeCache.get(frame);
    if (!options.visualData && entry && entry.key === cacheKey) {
        return entry.data;
    }

    // Prepare an alpha buffer if we're doing a full composite (needed for renderCanvas)
    // IMPORTANT: must be filled with 0 (transparent) so only drawn pixels are solid.
    const alphaBuffer = new Uint8Array(frame.width * frame.height).fill(0);
    const compositeData = compositeFrame(frame, {
        transparentIdx: TRANSPARENT_COLOR,
        floatingSelection: isCurrentFrame ? state.floatingSelection : null,
        showIndex0: options.showIndex0 !== undefined ? options.showIndex0 : true,
        backgroundIdx: options.backgroundIdx !== undefined ? options.backgroundIdx : TRANSPARENT_COLOR,
        alphaBuffer: alphaBuffer,
        includeExternalTmp: options.includeExternalTmp || false,
        visualData: options.visualData || null,
        palette: options.palette || state.palette,
        substitutionMap: options.substitutionMap || null,
        affectedIndices: options.affectedIndices || null,
        remapBase: options.remapBase || null,
        extraAlpha: state.flatCells ? 120 : 255
    });

    const result = {
        pixels: compositeData,
        alpha: alphaBuffer
    };

    if (!options.visualData) {
        _compositeCache.set(frame, { key: cacheKey, data: result });
    }
    return result;
}

export function createTileThumbnail(tile, w = 120, h = 90, options = {}) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');

    if (!tile) return c;

    const cached = _getCachedComposite(tile, options);
    const compositeData = cached.pixels;

    const tileW = tile.width;
    const tileH = tile.height;

    const pad = 8;
    const scale = Math.min((w - pad) / tileW, (h - pad) / tileH);
    const drawW = tileW * scale;
    const drawH = tileH * scale;

    const offsetX = (w - drawW) / 2;
    const offsetY = (h - drawH) / 2;

    const id = ctx.createImageData(w, h);
    const d = id.data;
    const d32 = new Uint32Array(d.buffer);

    const actualTransparent = state.isAlphaImageMode ? 127 : 0;
    const show0 = options.showIndex0 !== undefined ? options.showIndex0 : true;

    const palLUT = new Uint32Array(256);
    const isLE = new Uint8Array(new Uint32Array([0x01020304]).buffer)[0] === 0x04;
    for (let i = 0; i < 256; i++) {
        const col = state.palette[i];
        if (col) {
            if (isLE) palLUT[i] = (255 << 24) | (col.b << 16) | (col.g << 8) | col.r;
            else palLUT[i] = (col.r << 24) | (col.g << 16) | (col.b << 8) | 255;
        }
    }

    const invScale = 1 / scale;
    for (let py = 0; py < h; py++) {
        const ly = Math.floor((py - offsetY) * invScale);
        if (ly < 0 || ly >= tileH) continue;
        const rowBase = ly * tileW;
        const outRowBase = py * w;

        for (let px = 0; px < w; px++) {
            const lx = Math.floor((px - offsetX) * invScale);
            if (lx < 0 || lx >= tileW) continue;

            const colorIdx = compositeData[rowBase + lx];
            if (colorIdx !== TRANSPARENT_COLOR) {
                if (colorIdx === actualTransparent && !show0) continue;
                d32[outRowBase + px] = palLUT[colorIdx];
            }
        }
    }

    ctx.putImageData(id, 0, 0);
    return c;
}




// --- ADVANCED TOOLTIP SYSTEM ---
export let tooltipEl = null;

let tooltipsInitialized = false;
let tooltipTimeout = null;

export function setupTooltips() {
    if (tooltipsInitialized) return;
    tooltipsInitialized = true;

    tooltipEl = document.getElementById('uiTooltip');
    if (!tooltipEl) {
        tooltipEl = document.createElement('div');
        tooltipEl.id = 'uiTooltip';
        tooltipEl.className = 'ui-tooltip';
        document.body.appendChild(tooltipEl);
    }

    let _mouseX = 0, _mouseY = 0;
    let _activeTarget = null;
    let _activeText = null;
    let _showTimer = null;
    let _hideTimer = null;

    const _hideNow = () => {
        if (_showTimer) { clearTimeout(_showTimer); _showTimer = null; }
        if (tooltipEl) {
            tooltipEl.classList.remove('active');
            tooltipEl.style.display = 'none';
        }
        _activeTarget = null;
        _activeText = null;
    };

    const _startTimer = (target, text) => {
        if (_showTimer) clearTimeout(_showTimer);
        _activeTarget = target;
        _activeText = text;

        _showTimer = setTimeout(() => {
            _showTimer = null;
            if (!_activeTarget || !_activeText) return;

            const dialog = _activeTarget.closest('dialog[open]');
            const container = dialog || document.body;
            if (tooltipEl.parentElement !== container) container.appendChild(tooltipEl);

            tooltipEl.style.zIndex = "2147483647";
            tooltipEl.innerHTML = _activeText.replace(/\n/g, '<br>').replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
            tooltipEl.classList.add('active');
            tooltipEl.style.display = 'block';
            positionTooltip({ clientX: _mouseX, clientY: _mouseY });
        }, 150); // 150ms of idling to show (faster for menus)
    };

    const _onMove = (e) => {
        _mouseX = e.clientX;
        _mouseY = e.clientY;

        if (tooltipEl && tooltipEl.classList.contains('active')) {
            positionTooltip(e);
        } else if (_activeTarget) {
            // Mouse is moving while stationary timer is counting.
            // Reset the timer to ensure we only show when the user stops moving.
            _startTimer(_activeTarget, _activeText);
        }
    };
    document.addEventListener('mousemove', _onMove, { passive: true });

    document.addEventListener('mouseover', (e) => {
        const target = e.target.closest('[data-tooltip], [data-title], [title], [data-i18n-tooltip], [data-i18n-title]');
        if (!target) return;

        if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null; }

        let text = target.getAttribute('data-tooltip') || target.getAttribute('data-title') || target.getAttribute('title');
        if (!text || !text.trim()) {
            const i18nKey = target.getAttribute('data-i18n-tooltip') || target.getAttribute('data-i18n-title');
            if (i18nKey) text = t(i18nKey);
        }

        if (target.hasAttribute('title')) {
            const nativeTitle = target.getAttribute('title');
            if (nativeTitle) {
                target.setAttribute('data-title', nativeTitle);
                target.removeAttribute('title');
                text = nativeTitle;
            }
        }

        if (text && text.trim()) {
            if (text === _activeText && (tooltipEl.classList.contains('active') || _showTimer)) {
                _activeTarget = target;
                return;
            }

            if (tooltipEl.classList.contains('active')) {
                _activeTarget = target;
                _activeText = text;
                tooltipEl.innerHTML = text.replace(/\n/g, '<br>').replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
                positionTooltip({ clientX: _mouseX, clientY: _mouseY });
            } else {
                _hideNow();
                _startTimer(target, text);
            }
        }
    });

    document.addEventListener('mouseout', (e) => {
        if (_hideTimer) clearTimeout(_hideTimer);
        _hideTimer = setTimeout(() => {
            _hideNow();
            _hideTimer = null;
        }, 50); 
    });
}

export function positionTooltip(e) {
    if (!tooltipEl) return;
    const offset = 15;
    let left = e.clientX + offset;
    let top = e.clientY + offset;

    // Boundary check using viewport dimensions
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Temporary layout to get dimensions
    tooltipEl.style.left = '-1000px';
    tooltipEl.style.top = '-1000px';
    tooltipEl.style.display = 'block';
    const rect = tooltipEl.getBoundingClientRect();

    // Tooltip uses 'fixed' positioning, so coordinates are relative to the viewport.
    // If a parent dialog has a CSS transform, 'fixed' would be relative to the dialog instead.
    const parentDialog = tooltipEl.closest('dialog[open]');

    if (left + rect.width > vw) {
        left -= (rect.width + offset * 2);
    }
    if (top + rect.height > vh) {
        top -= (rect.height + offset * 2);
    }

    // Ensure it doesn't go off-screen top/left
    if (left < 0) left = 0;
    if (top < 0) top = 0;

    // If it's inside a dialog, we might need to adjust for the dialog's scroll/position 
    // IF it's not actually 'fixed' relative to viewport.
    // Test: if it WAS missing, it's likely because I was subtracting dRect.left.

    tooltipEl.style.left = left + 'px';
    tooltipEl.style.top = top + 'px';
}

/**
 * Recursively (globally) sets up hover logic for all submenu triggers.
 * Handles fixed positioning and vertical overflow to ensure submenus are never clipped.
 */
export function setupSubmenusRecursive(container = document.body) {
    if (!container) return;
    container.querySelectorAll('.submenu-trigger').forEach(trig => {
        const item = trig.parentElement;

        // Cleanup old handlers if any to avoid leaks/duplicates
        if (trig._submenuMe) trig.removeEventListener('mouseenter', trig._submenuMe);
        if (item._submenuMl) item.removeEventListener('mouseleave', item._submenuMl);

        trig._submenuMe = () => {
            const sub = trig.nextElementSibling;
            if (sub && sub.classList.contains('menu-dropdown')) {
                const rect = trig.getBoundingClientRect();
                const vh = window.innerHeight;

                sub.style.position = 'fixed';
                sub.style.zIndex = '3000000';
                
                // Horizontal check
                const subWidth = sub.offsetWidth || 260; // Approximate for Z-Data
                if (rect.right + subWidth > window.innerWidth - 10) {
                    if (rect.left - subWidth > 10) {
                        sub.style.left = (rect.left - subWidth + 1) + 'px';
                    } else {
                        sub.style.left = '10px';
                    }
                } else {
                    sub.style.left = (rect.right - 1) + 'px';
                }

                // Handle vertical overflow
                sub.style.top = rect.top + 'px';
                sub.style.bottom = 'auto'; // Reset bottom
                sub.style.maxHeight = (vh - rect.top - 10) + 'px';
                sub.style.overflowY = 'auto';

                // If it's still too small (< 300px) and we have space above, shift it up
                if (parseFloat(sub.style.maxHeight) < 300 && rect.top > vh / 2) {
                    const availableAbove = rect.bottom;
                    const targetHeight = Math.min(600, availableAbove - 10);
                    sub.style.top = 'auto';
                    sub.style.bottom = (vh - rect.bottom) + 'px';
                    sub.style.maxHeight = targetHeight + 'px';
                }

                sub.style.display = 'block';
                sub.style.visibility = 'visible';
                sub.style.opacity = '1';
                sub.classList.add('active');
            }
        };

        item._submenuMl = () => {
            const sub = trig.nextElementSibling;
            if (sub && sub.classList.contains('menu-dropdown')) {
                sub.classList.remove('active');
                sub.style.display = 'none';
                sub.style.visibility = 'hidden';
                sub.style.maxHeight = '';
                sub.style.top = '';
                sub.style.bottom = '';
            }
        };

        trig.addEventListener('mouseenter', trig._submenuMe);
        item.addEventListener('mouseleave', item._submenuMl);

        // Prevent click logic from conflicting
        trig.onclick = (e) => e.stopPropagation();
    });
}
/**
 * Updates the disabled state of the "New Extra Data" button based on current selection.
 */
export function updateExtraBtnState() {
    const btn = document.getElementById('btnNewExtra');
    if (!btn) return;

    // Get unique indices of selected cells from tileSelection
    const indices = state.tileSelection;

    if (indices.size === 0) {
        btn.disabled = true;
        return;
    }

    // Enabled only if at least one selected cell DOES NOT have extra data
    let canAdd = false;
    for (const idx of indices) {
        const tile = state.tiles[idx];
        if (tile && tile.tileHeader && !tile.tileHeader.has_extra_data) {
            canAdd = true;
            break;
        }
    }
    btn.disabled = !canAdd;
}

/**
 * Creates empty extra data for selected cells that don't have it.
 */
export function createExtraDataForSelected() {
    // Get unique indices of selected cells
    const indices = state.tileSelection;

    if (indices.size === 0) return;

    let changed = false;
    pushHistory();

    indices.forEach(idx => {
        const tile = state.tiles[idx];
        if (tile && tile.tileHeader && !tile.tileHeader.has_extra_data) {
            const cx = parseInt(state.cx) || (state.gameType === 'ts' ? 48 : 60);
            const cy = parseInt(state.cy) || (state.gameType === 'ts' ? 24 : 30);
            
            tile.tileHeader.has_extra_data = 1;
            tile.tileHeader.cx_extra = cx;
            tile.tileHeader.cy_extra = cy;
            tile.tileHeader.x_extra = tile.tileHeader.x;
            tile.tileHeader.y_extra = tile.tileHeader.y;

            // Initialize empty buffers safely
            tile.extraImageData = new Uint8Array(cx * cy).fill(0);
            tile.extraZData = new Uint8Array(cx * cy).fill(0);
            changed = true;
            
            if (!state.bondSelection) {
                state.subSelection.add(`${idx}_extra`);
            }
        }
    });

    if (changed) {
        recomputeWorldBoundsFromState();
        updateTilesList();
        renderCanvas();
        updateExtraBtnState();
        updateTileProperties();
    }
}

/**
 * Recomputes the global bounding box encompassing all tiles in the current state
 * and adjusts the canvas width and height dynamically so no pieces are cut off.
 */
export function recomputeWorldBoundsFromState() {
    const mult = state.flatCells ? 0 : (state.cy / 2);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, found = false;

    for (let i = 0; i < state.tiles.length; i++) {
        const tile = state.tiles[i];
        if (!tile || !tile.tileHeader) continue;
        moveTileBy(i, 0, 0, false); 
        found = true;
        const h = tile.tileHeader;
        
        // Always account for both elevated top and shadow bottom to ensure origin consistency
        const elev = h.height * mult;
        const absX = h.x;
        const elevatedTop = h.y - elev;
        const shadowBottom = h.y + state.cy;

        minX = Math.min(minX, absX);
        minY = Math.min(minY, elevatedTop);
        maxX = Math.max(maxX, absX + state.cx);
        // Copy/Paste consistency: use elevated bottom for data bounds
        maxY = Math.max(maxY, elevatedTop + state.cy);

        if (h.has_extra_data && h.cx_extra > 0 && h.cy_extra > 0) {
            minX = Math.min(minX, h.x_extra);
            minY = Math.min(minY, h.y_extra - elev);
            maxX = Math.max(maxX, h.x_extra + h.cx_extra);
            maxY = Math.max(maxY, h.y_extra - elev + h.cy_extra);
        }
    }

    if (!found) {
        state.worldBounds = { minX: 0, minY: 0, width: state.cx, height: state.cy, hasTiles: false };
    } else {
        // Force integers to prevent sub-pixel jitter in projection
        const fMinX = Math.floor(minX);
        const fMinY = Math.floor(minY);
        const fMaxX = Math.ceil(maxX);
        const fMaxY = Math.ceil(maxY);
        state.worldBounds = { 
            minX: fMinX, minY: fMinY, maxX: fMaxX, maxY: fMaxY, 
            width: fMaxX - fMinX, height: fMaxY - fMinY, hasTiles: true 
        };
    }

    if (state.worldBounds && state.worldBounds.hasTiles) {
        const MAX_WORLD = 32000;
        let w = Math.ceil(state.worldBounds.width);
        let h = Math.ceil(state.worldBounds.height);
        
        // Final sanity check before updating state.canvasW/H
        if (w > MAX_WORLD || h > MAX_WORLD || w <= 0 || h <= 0) {
            console.warn(`[Bounds] Rejecting astronomical bounds: ${w}x${h}`);
            w = Math.min(w, MAX_WORLD);
            h = Math.min(h, MAX_WORLD);
        }
        state.canvasW = w;
        state.canvasH = h;
    } else {
        state.canvasW = state.cx;
        state.canvasH = state.cy;
    }
    updateCanvasSize();
    
    // Ensure the canvas is redrawn after bound changes (which resets the canvas width/height)
    requestAnimationFrame(() => {
        renderCanvas();
    });
}

/**
 * Moves a tile's base diamond (and optionally its extra data) by (dx, dy) world pixels.
 * Updates all derived cached fields on the tile object.
 * @param {number} idx - Tile index in state.tiles
 * @param {number} dx - Delta X in world pixels
 * @param {number} dy - Delta Y in world pixels
 * @param {boolean} moveExtra - If true, move extra data in sync (Bond mode)
 */
export function moveTileBy(idx, dx, dy, moveExtra) {
    const tile = state.tiles[idx];
    if (!tile || !tile.tileHeader) return;
    const h = tile.tileHeader;
    const mult = state.cy / 2;

    // Update header world coords
    h.x += dx;
    h.y += dy;

    if (moveExtra && h.has_extra_data) {
        h.x_extra += dx;
        h.y_extra += dy;
    }

    // Recompute derived bounding-box fields from scratch
    const elevation = state.flatCells ? 0 : h.height * mult;
    const diamondAbsX = h.x;
    const diamondAbsY = h.y - elevation;

    let minX = diamondAbsX;
    let maxX = diamondAbsX + state.cx;
    let minY = diamondAbsY;
    let maxY = diamondAbsY + state.cy;

    if (h.has_extra_data && h.cx_extra > 0 && h.cy_extra > 0) {
        const ex = h.x_extra;
        const ey = h.y_extra - elevation;
        minX = Math.min(minX, ex);
        minY = Math.min(minY, ey);
        maxX = Math.max(maxX, ex + h.cx_extra);
        maxY = Math.max(maxY, ey + h.cy_extra);
    }

    tile.itemMinX = minX;
    tile.itemMinY = minY;
    tile.width  = maxX - minX;
    tile.height = maxY - minY;
    tile.diamondX = diamondAbsX - minX;
    tile.diamondY = diamondAbsY - minY;
    tile.extraX = h.x_extra - minX;
    tile.extraY = (h.y_extra - elevation) - minY;

    tile._v = (tile._v || 0) + 1;
}

/**
 * Moves all currently selected tiles by a specific pixel delta.
 * Used for Move Mode (keyboard + dragging).
 */
export function moveSelectedTilesPixels(dx, dy) {
    if (state.tileSelection.size === 0) return;
    
    // We only need one history entry for the entire group move
    pushHistory();
    if (state.bondSelection) {
        const selected = Array.from(state.tileSelection);
        for (const idx of selected) {
            moveTileBy(idx, dx, dy, true);
        }
    } else {
        // Move parts individually based on subSelection
        for (const key of state.subSelection) {
            const [idxStr, subType] = key.split('_');
            const idx = parseInt(idxStr);
            if (subType === 'base') {
                moveTileBy(idx, dx, dy, false);
            } else if (subType === 'extra') {
                moveExtraBy(idx, dx, dy);
            }
        }
    }
    recomputeWorldBoundsFromState();
    updateTileProperties();
    renderCanvas();
}

/**
 * Moves ONLY the extra data of all tiles in the current sub-selection.
 */
export function moveSelectedExtraPixels(dx, dy) {
    if (state.tileSelection.size === 0) return;
    pushHistory();
    
    if (state.bondSelection) {
        // Mode BOND: Move extra section of all tiles in the main selection
        for (const idx of state.tileSelection) {
            const tile = state.tiles[idx];
            if (tile && tile.tileHeader && tile.tileHeader.has_extra_data) {
                moveExtraBy(idx, dx, dy);
            }
        }
    } else {
        // Mode DECOUPLED: Move only specifically selected extra data parts
        for (const key of state.subSelection) {
            const [idxStr, subType] = key.split('_');
            const idx = parseInt(idxStr);
            if (subType === 'extra') {
                moveExtraBy(idx, dx, dy);
            }
        }
    }
    recomputeWorldBoundsFromState();
    updateTileProperties();
    renderCanvas();
}

/**
 * Checks if a tile overlaps with any other tile on the map.
 * Uses exact isometric diamond distance for collision.
 */
function _isTileOverlapping(idx) {
    const t1 = state.tiles[idx];
    if (!t1 || !t1.tileHeader) return false;
    const h1 = t1.tileHeader;
    const hw = state.cx / 2;
    const hh = state.cy / 2;

    for (let i = 0; i < state.tiles.length; i++) {
        if (i === idx) continue;
        const t2 = state.tiles[i];
        if (!t2 || !t2.tileHeader) continue;
        const h2 = t2.tileHeader;

        // STRICT Diamond-to-Diamond intersection (Base only)
        // Correct overlap condition for two identical diamonds: |dx|/cx + |dy|/cy < 1
        const dx = h1.x - h2.x;
        const dy = h1.y - h2.y;
        if ((Math.abs(dx) / state.cx + Math.abs(dy) / state.cy) < 0.999) return true;
    }
    return false;
}

/**
 * Moves ONLY the extra data of a tile by (dx, dy) world pixels.
 * Recomputes bounding-box fields so extraX/extraY stay consistent.
 */
export function moveExtraBy(idx, dx, dy) {
    const tile = state.tiles[idx];
    if (!tile || !tile.tileHeader) return;
    const h = tile.tileHeader;
    if (!h.has_extra_data) return;
    const mult = state.cy / 2;

    h.x_extra += dx;
    h.y_extra += dy;

    // Recompute bounding box (diamond position unchanged)
    const elevation = state.flatCells ? 0 : h.height * mult;
    const diamondAbsX = h.x;
    const diamondAbsY = h.y - elevation;

    let minX = diamondAbsX;
    let maxX = diamondAbsX + state.cx;
    let minY = diamondAbsY;
    let maxY = diamondAbsY + state.cy;

    if (h.cx_extra > 0 && h.cy_extra > 0) {
        const ex = h.x_extra;
        const ey = h.y_extra - elevation;
        minX = Math.min(minX, ex);
        minY = Math.min(minY, ey);
        maxX = Math.max(maxX, ex + h.cx_extra);
        maxY = Math.max(maxY, ey + h.cy_extra);
    }

    tile.itemMinX = minX;
    tile.itemMinY = minY;
    tile.width  = maxX - minX;
    tile.height = maxY - minY;
    tile.diamondX = diamondAbsX - minX;
    tile.diamondY = diamondAbsY - minY;
    tile.extraX = h.x_extra - minX;
    tile.extraY = (h.y_extra - elevation) - minY;

    tile._v = (tile._v || 0) + 1;
}

/**
 * Updates the Properties panel based on currently selected tile.
 */
export function updateTileProperties() {
    const container = document.getElementById('tileProperties');
    if (!container) return;

    const idx = state.currentTileIdx;
    const prevDisplay = elements.panelRight ? elements.panelRight.style.display : '';

    if (idx === -1 || !state.tiles[idx]) {
        if (elements.panelRight) elements.panelRight.style.display = 'none';
        if (elements.panelRightResizer) elements.panelRightResizer.style.display = 'none';
        container.innerHTML = `
            <div style="font-size: 11px; color: #666; font-style: italic; text-align: center; padding: 20px;">
                ${t('msg_select_tile_props')}
            </div>`;
        return;
    }

    if (elements.panelRight) elements.panelRight.style.display = 'flex';
    if (elements.panelRightResizer) elements.panelRightResizer.style.display = 'block';

    const tile = state.tiles[idx];
    const header = tile.tileHeader;
    if (!header) {
        container.innerHTML = `
            <div style="font-size: 11px; color: #666; font-style: italic; text-align: center; padding: 20px;">
                ${t('msg_tile_context_unavailable')}
            </div>`;
        return;
    }

    const bigStep = (state.cx === 48) ? 4 : 5;

    // Detect mixed states for multi-selection
    const isMultiSelection = state.tileSelection.size > 1;
    let mixed = {
        x: false, y: false, height: false, land: false, ramp: false,
        radLR: false, radLG: false, radLB: false,
        radRR: false, radRG: false, radRB: false,
        exX: false, exY: false
    };

    if (isMultiSelection) {
        const firstIdx = [...state.tileSelection][0];
        const firstH = state.tiles[firstIdx]?.tileHeader;
        if (firstH) {
            for (const sIdx of state.tileSelection) {
                const h = state.tiles[sIdx]?.tileHeader;
                if (!h) continue;
                if (h.x !== firstH.x) mixed.x = true;
                if (h.y !== firstH.y) mixed.y = true;
                if (h.height !== firstH.height) mixed.height = true;
                if (h.land_type !== firstH.land_type) mixed.land = true;
                if (h.ramp_type !== firstH.ramp_type) mixed.ramp = true;
                if (h.radar_red_left !== firstH.radar_red_left) mixed.radLR = true;
                if (h.radar_green_left !== firstH.radar_green_left) mixed.radLG = true;
                if (h.radar_blue_left !== firstH.radar_blue_left) mixed.radLB = true;
                if (h.radar_red_right !== firstH.radar_red_right) mixed.radRR = true;
                if (h.radar_green_right !== firstH.radar_green_right) mixed.radRG = true;
                if (h.radar_blue_right !== firstH.radar_blue_right) mixed.radRB = true;
                if (h.x_extra !== firstH.x_extra) mixed.exX = true;
                if (h.y_extra !== firstH.y_extra) mixed.exY = true;
            }
        }
    }

    // Previews section removed as requested

    const rgbToHex = (r, g, b) => {
        return "#" + (1 << 24 | (r || 0) << 16 | (g || 0) << 8 | (b || 0)).toString(16).slice(1);
    };

    const radarSection = `
        <div style="border-top: 1px solid #2d3748; margin: 4px 0 2px 0;"></div>
        <div style="font-size: 11px; color: #ffffff; text-transform: uppercase; font-weight: 700; letter-spacing: 1px; margin-bottom: 2px; padding: 0 2px;">${t('lbl_radar_colors')}</div>
        
        <div style="display: flex; flex-direction: column; gap: 4px;">
            <!-- Left Radar -->
            <div style="display: flex; align-items: center; gap: 8px;" data-title="${t('tt_prop_radar_left')}">
                <span style="font-size: 9px; color: #718096; text-transform: uppercase; width: 35px; font-weight: 700;">${t('lbl_left')}</span>
                <div style="display: flex; background: var(--bg-input); border-radius: 4px; border: 1px solid var(--border); overflow: hidden; height: 26px;">
                    <input type="number" id="radL_R" class="input-step" value="${mixed.radLR ? '' : header.radar_red_left}" placeholder="${mixed.radLR ? '---' : ''}" min="0" max="255" style="width: 42px; background: transparent; border: none; border-right: 1px solid var(--border); color: #cbd5e0; font-size: 13px; text-align: center; padding: 0; font-weight: bold;">
                    <input type="number" id="radL_G" class="input-step" value="${mixed.radLG ? '' : header.radar_green_left}" placeholder="${mixed.radLG ? '---' : ''}" min="0" max="255" style="width: 42px; background: transparent; border: none; border-right: 1px solid var(--border); color: #cbd5e0; font-size: 13px; text-align: center; padding: 0; font-weight: bold;">
                    <input type="number" id="radL_B" class="input-step" value="${mixed.radLB ? '' : header.radar_blue_left}" placeholder="${mixed.radLB ? '---' : ''}" min="0" max="255" style="width: 42px; background: transparent; border: none; color: #cbd5e0; font-size: 13px; text-align: center; padding: 0; font-weight: bold;">
                </div>
                <div style="position: relative; width: 26px; height: 26px; border-radius: 4px; border: 1px solid var(--border); overflow: hidden; background: transparent">
                    <input type="color" id="propRadarLeft" value="${mixed.radLR || mixed.radLG || mixed.radLB ? '#000000' : rgbToHex(header.radar_red_left, header.radar_green_left, header.radar_blue_left)}" style="position: absolute; top: -50%; left: -50%; width: 200%; height: 200%; cursor: pointer; border: none; background: transparent; opacity: 1">
                    ${mixed.radLR || mixed.radLG || mixed.radLB ? '<div style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 10px; font-weight: bold; pointer-events: none;">---</div>' : ''}
                </div>
            </div>
            
            <!-- Right Radar -->
            <div style="display: flex; align-items: center; gap: 8px;" data-title="${t('tt_prop_radar_right')}">
                <span style="font-size: 9px; color: #718096; text-transform: uppercase; width: 35px; font-weight: 700;">${t('lbl_right')}</span>
                <div style="display: flex; background: var(--bg-input); border-radius: 4px; border: 1px solid var(--border); overflow: hidden; height: 26px;">
                    <input type="number" id="radR_R" class="input-step" value="${mixed.radRR ? '' : header.radar_red_right}" placeholder="${mixed.radRR ? '---' : ''}" min="0" max="255" style="width: 42px; background: transparent; border: none; border-right: 1px solid var(--border); color: #cbd5e0; font-size: 13px; text-align: center; padding: 0; font-weight: bold;">
                    <input type="number" id="radR_G" class="input-step" value="${mixed.radRG ? '' : header.radar_green_right}" placeholder="${mixed.radRG ? '---' : ''}" min="0" max="255" style="width: 42px; background: transparent; border: none; border-right: 1px solid var(--border); color: #cbd5e0; font-size: 13px; text-align: center; padding: 0; font-weight: bold;">
                    <input type="number" id="radR_B" class="input-step" value="${mixed.radRB ? '' : header.radar_blue_right}" placeholder="${mixed.radRB ? '---' : ''}" min="0" max="255" style="width: 42px; background: transparent; border: none; color: #cbd5e0; font-size: 13px; text-align: center; padding: 0; font-weight: bold;">
                </div>
                <div style="position: relative; width: 26px; height: 26px; border-radius: 4px; border: 1px solid var(--border); overflow: hidden; background: transparent">
                    <input type="color" id="propRadarRight" value="${mixed.radRR || mixed.radRG || mixed.radRB ? '#000000' : rgbToHex(header.radar_red_right, header.radar_green_right, header.radar_blue_right)}" style="position: absolute; top: -50%; left: -50%; width: 200%; height: 200%; cursor: pointer; border: none; background: transparent; opacity: 1">
                    ${mixed.radRR || mixed.radRG || mixed.radRB ? '<div style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 10px; font-weight: bold; pointer-events: none;">---</div>' : ''}
                </div>
            </div>
        </div>
    `;

    const isMultiBase = state.tileSelection.size > 1;
    const isMultiExtra = state.bondSelection ? (state.tileSelection.size > 1) : (state.subSelection.size > 1);

    const hasExtra = !!(header.has_extra_data && tile.extraImageData);
    const extraSection = hasExtra ? `
        <div style="border-top: 1px solid #2d3748; margin: 4px 0 2px 0;"></div>
        <div style="font-size: 11px; color: var(--accent); text-transform: uppercase; letter-spacing: 1.5px; padding: 0 2px; margin-bottom: 2px; font-weight: 800;">${t('lbl_extra_data_caps')}</div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px;">
            <div style="display: flex; flex-direction: column; gap: 2px;">
                <label style="font-size: 11px; color: #ffffff; text-transform: uppercase; letter-spacing: 0.5px;">${t('lbl_x_position_caps')}</label>
                <div class="input-stepper" style="height: 24px;" data-title="${t('tt_prop_extra_x')}">
                    <button id="btnPropExXMinus" class="step-btn step-btn-minus" data-title="${t('tt_lp_extra_xoff_minus')}">−</button>
                    <input type="number" id="propExX" class="input-step" value="${mixed.exX ? '' : (header.x_extra || 0)}" placeholder="${mixed.exX ? '---' : ''}" ${isMultiExtra ? 'disabled' : ''}>
                    <button id="btnPropExXPlus" class="step-btn step-btn-plus" data-title="${t('tt_lp_extra_xoff_plus')}">+</button>
                </div>
            </div>
            <div style="display: flex; flex-direction: column; gap: 2px;">
                <label style="font-size: 11px; color: #ffffff; text-transform: uppercase; letter-spacing: 0.5px;">${t('lbl_y_position_caps')}</label>
                <div class="input-stepper" style="height: 24px;" data-title="${t('tt_prop_extra_y')}">
                    <button id="btnPropExYMinus" class="step-btn step-btn-minus" data-title="${t('tt_lp_extra_yoff_minus')}">−</button>
                    <input type="number" id="propExY" class="input-step" value="${mixed.exY ? '' : (header.y_extra || 0)}" placeholder="${mixed.exY ? '---' : ''}" ${isMultiExtra ? 'disabled' : ''}>
                    <button id="btnPropExYPlus" class="step-btn step-btn-plus" data-title="${t('tt_lp_extra_yoff_plus')}">+</button>
                </div>
            </div>
        </div>` : '';

    let landOptions = mixed.land ? `<option value="" selected disabled>--- Mixed Values ---</option>` : '';
    landOptions += Object.entries(LAND_TYPE_NAMES).map(([val, name]) => 
        `<option value="${val}" ${(!mixed.land && header.land_type == val) ? 'selected' : ''}>${val}: ${t(name)}</option>`
    ).join('');

    let rampOptions = mixed.ramp ? `<option value="" selected disabled>--- ${t('lbl_mixed_values')} ---</option>` : '';
    rampOptions += Object.entries(RAMP_TYPE_NAMES).map(([val, name]) => 
        `<option value="${val}" ${(!mixed.ramp && header.ramp_type == val) ? 'selected' : ''}>${val}: ${t(name)}</option>`
    ).join('');

    container.innerHTML = `
        <div style="padding: 4px 8px; display: flex; flex-direction: column; gap: 4px;">
            <div style="font-size: 11px; color: var(--accent); text-transform: uppercase; letter-spacing: 1.5px; padding: 0 2px; margin-bottom: 0; font-weight: 800;">${t('lbl_cell_caps')}</div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px;">
                <div style="display: flex; flex-direction: column; gap: 2px;">
                    <label style="font-size: 11px; color: #ffffff; text-transform: uppercase; letter-spacing: 0.5px;">${t('lbl_x_position_caps')}</label>
                    <div class="input-stepper" style="height: 24px;" data-title="${t('tt_prop_x')}">
                        <button id="btnPropXMinus" class="step-btn step-btn-minus" data-title="${t('tt_lp_xoff_minus')}">−</button>
                        <input type="number" id="propX" class="input-step" value="${mixed.x ? '' : header.x}" placeholder="${mixed.x ? '---' : ''}" ${isMultiBase ? 'disabled' : ''}>
                        <button id="btnPropXPlus" class="step-btn step-btn-plus" data-title="${t('tt_lp_xoff_plus')}">+</button>
                    </div>
                </div>
                <div style="display: flex; flex-direction: column; gap: 2px;">
                    <label style="font-size: 11px; color: #ffffff; text-transform: uppercase; letter-spacing: 0.5px;">${t('lbl_y_position_caps')}</label>
                    <div class="input-stepper" style="height: 24px;" data-title="${t('tt_prop_y')}">
                        <button id="btnPropYMinus" class="step-btn step-btn-minus" data-title="${t('tt_lp_yoff_minus')}">−</button>
                        <input type="number" id="propY" class="input-step" value="${mixed.y ? '' : header.y}" placeholder="${mixed.y ? '---' : ''}" ${isMultiBase ? 'disabled' : ''}>
                        <button id="btnPropYPlus" class="step-btn step-btn-plus" data-title="${t('tt_lp_yoff_plus')}">+</button>
                    </div>
                </div>
            </div>
            <div style="display: flex; flex-direction: column; gap: 2px;">
                <label style="font-size: 11px; color: #ffffff; text-transform: uppercase; letter-spacing: 0.5px;">${t('lbl_height')}</label>
                <div class="input-stepper" style="height: 24px;" data-title="${t('tt_prop_h')}">
                    <button id="btnPropHMinus" class="step-btn step-btn-minus" data-title="${t('tt_lp_height_minus')}">−</button>
                    <input type="number" id="propH" class="input-step" value="${mixed.height ? '' : header.height}" placeholder="${mixed.height ? '---' : ''}">
                    <button id="btnPropHPlus" class="step-btn step-btn-plus" data-title="${t('tt_lp_height_plus')}">+</button>
                </div>
            </div>
            <div style="display: flex; flex-direction: column; gap: 2px;">
                <label style="font-size: 11px; color: #ffffff; text-transform: uppercase; letter-spacing: 0.5px;">${t('lbl_land_type')}</label>
                <select id="propLand" class="input-dark" style="height: 26px; padding: 0 6px; font-size: 13px;" data-title="${t('tt_prop_land')}">
                    ${landOptions}
                </select>
            </div>
            <div style="display: flex; flex-direction: column; gap: 2px;">
                <label style="font-size: 11px; color: #ffffff; text-transform: uppercase; letter-spacing: 0.5px;">${t('lbl_ramp_type')}</label>
                <div style="display: flex; gap: 6px;">
                    <select id="propRamp" class="input-dark" style="height: 32px; padding: 0 6px; font-size: 13px; flex-grow: 1;" data-title="${t('tt_prop_ramp')}">
                        ${rampOptions}
                    </select>
                    <div style="width: 44px; height: 32px; border: 1px solid var(--border); box-sizing: border-box; overflow: hidden; background: #000; flex-shrink: 0; display: flex; align-items: center; justify-content: center; border-radius: 4px;">
                        <img id="propRampImg" src="" style="display: none; image-rendering: pixelated; width: 100%; height: 100%; object-fit: contain;">
                    </div>
                </div>
            </div>
            <div style="display: flex; gap: 4px; padding: 4px 0; flex-direction: row; justify-content: space-between; align-items: center;" data-title="${t('tt_prop_damaged')}">
                <label style="font-size: 11px; color: #ffffff; text-transform: uppercase; cursor: pointer; font-weight: 700;" for="propDamaged">${t('lbl_has_damaged_artwork')}</label>
                <input type="checkbox" id="propDamaged" ${header.has_damaged_data ? 'checked' : ''} style="cursor: pointer; width: auto; margin: 0;">
            </div>
            ${radarSection}
            ${extraSection}
        </div>
    `;

    // Preview logic removed as requested

    // ---- Element refs ----
    const inpX   = document.getElementById('propX');
    const inpY   = document.getElementById('propY');
    const inpH   = document.getElementById('propH');
    const selLand = document.getElementById('propLand');
    const selRamp = document.getElementById('propRamp');
    const inpExX = hasExtra ? document.getElementById('propExX') : null;
    const inpExY = hasExtra ? document.getElementById('propExY') : null;

    // ---- Base tile movement ----
    const applyMove = (dxWorld, dyWorld) => {
        if (state.tileSelection.size > 1) {
            moveSelectedTilesPixels(dxWorld, dyWorld);
        } else {
            pushHistory();
            moveTileBy(idx, dxWorld, dyWorld, state.bondSelection);
            recomputeWorldBoundsFromState();
            renderCanvas();
        }
        if (inpX)   inpX.value   = header.x;
        if (inpY)   inpY.value   = header.y;
        if (inpExX) inpExX.value = header.x_extra;
        if (inpExY) inpExY.value = header.y_extra;
        
        updateTileDataTable(); // Ensure table updates in live
    };

    if (inpX) {
        inpX.disabled = (state.tileSelection.size > 1);
        inpX.onchange = (e) => { const d = (parseInt(e.target.value)||0) - header.x; if (d) applyMove(d, 0); };
    }
    if (inpY) {
        inpY.disabled = (state.tileSelection.size > 1);
        inpY.onchange = (e) => { const d = (parseInt(e.target.value)||0) - header.y; if (d) applyMove(0, d); };
    }

    const bXm = document.getElementById('btnPropXMinus');
    const bXp = document.getElementById('btnPropXPlus');
    const bYm = document.getElementById('btnPropYMinus');
    const bYp = document.getElementById('btnPropYPlus');
    if (bXm) setupAutoRepeat(bXm, (e) => applyMove(-(e.ctrlKey ? bigStep : 1), 0));
    if (bXp) setupAutoRepeat(bXp, (e) => applyMove(+(e.ctrlKey ? bigStep : 1), 0));
    if (bYm) setupAutoRepeat(bYm, (e) => applyMove(0, -(e.ctrlKey ? bigStep : 1)));
    if (bYp) setupAutoRepeat(bYp, (e) => applyMove(0, +(e.ctrlKey ? bigStep : 1)));
    
    // Block scientific notation 'e', plus sign and decimals in all numeric inputs
    container.querySelectorAll('.input-step').forEach(inp => {
        inp.addEventListener('keydown', (e) => {
            if (['e', 'E', '+', '.'].includes(e.key)) {
                e.preventDefault();
            }
        });
    });

    // ---- Height and Types ----
    const applyHeight = (val, isDelta = false) => {
        pushHistory();
        if (state.tileSelection.size > 1) {
            for (const sIdx of state.tileSelection) {
                const t = state.tiles[sIdx];
                if (t && t.tileHeader) {
                    if (isDelta) t.tileHeader.height = Math.max(0, t.tileHeader.height + val);
                    else t.tileHeader.height = val;
                    moveTileBy(sIdx, 0, 0, false);
                }
            }
        } else {
            if (isDelta) header.height = Math.max(0, header.height + val);
            else header.height = val;
            moveTileBy(idx, 0, 0, false);
        }
        recomputeWorldBoundsFromState();
        if (inpH) inpH.value = header.height;
        renderCanvas();
        updateTileDataTable();
    };

    if (inpH) inpH.onchange = (e) => applyHeight(parseInt(e.target.value)||0, false);
    const bHm = document.getElementById('btnPropHMinus');
    const bHp = document.getElementById('btnPropHPlus');
    if (bHm) setupAutoRepeat(bHm, () => applyHeight(-1, true));
    if (bHp) setupAutoRepeat(bHp, () => applyHeight(1, true));

    if (selLand) selLand.onchange = (e) => {
        const val = parseInt(e.target.value);
        pushHistory();
        if (state.tileSelection.size > 1) {
            for (const sIdx of state.tileSelection) {
                const t = state.tiles[sIdx];
                if (t && t.tileHeader) t.tileHeader.land_type = val;
            }
        } else {
            header.land_type = val;
        }
        updateTileDataTable();
    };
    const propRampImg = document.getElementById('propRampImg');
    const updateRampImage = (val) => {
        if (!propRampImg) return;
        if (val !== '' && !isNaN(val) && RAMP_IMAGES && RAMP_IMAGES[val]) {
            propRampImg.src = RAMP_IMAGES[val];
            propRampImg.style.display = 'block';
            
            // Extract the background color from pixel 0 of Ramp Type 0
            if (RAMP_IMAGES[0] && !window._rampBgColor) {
                const img0 = new Image();
                img0.onload = () => {
                    const c = document.createElement('canvas');
                    c.width = 1; c.height = 1;
                    const ctx = c.getContext('2d', { willReadFrequently: true });
                    ctx.drawImage(img0, 0, 0, 1, 1, 0, 0, 1, 1);
                    const p = ctx.getImageData(0, 0, 1, 1).data;
                    window._rampBgColor = `rgb(${p[0]},${p[1]},${p[2]})`;
                    propRampImg.parentElement.style.background = window._rampBgColor;
                };
                img0.src = RAMP_IMAGES[0];
            } else if (window._rampBgColor) {
                propRampImg.parentElement.style.background = window._rampBgColor;
            }
            
        } else {
            propRampImg.src = '';
            propRampImg.style.display = 'none';
        }
    };
    if (!mixed.ramp) updateRampImage(header.ramp_type);

    if (selRamp) selRamp.onchange = (e) => {
        const val = parseInt(e.target.value);
        if (isNaN(val)) return;
        pushHistory();
        if (state.tileSelection.size > 1) {
            for (const sIdx of state.tileSelection) {
                const t = state.tiles[sIdx];
                if (t && t.tileHeader) t.tileHeader.ramp_type = val;
            }
        } else {
            header.ramp_type = val;
        }
        updateRampImage(val);
        updateTileDataTable();
    };
    
    const propDam = document.getElementById('propDamaged');
    if (propDam) propDam.onchange = (e) => {
        const val = e.target.checked;
        pushHistory();
        if (state.tileSelection.size > 1) {
            for (const sIdx of state.tileSelection) {
                const t = state.tiles[sIdx];
                if (t && t.tileHeader) t.tileHeader.has_damaged_data = val;
            }
        } else {
            header.has_damaged_data = val;
        }
        updateTileDataTable();
    };

    // ---- Radar Colors ----
    const hexToRgb = (hex) => {
        if (!hex) return { r: 0, g: 0, b: 0 };
        const bigint = parseInt(hex.substring(1), 16);
        return {r: (bigint >> 16) & 255, g: (bigint >> 8) & 255, b: bigint & 255};
    };

    const radLeft = document.getElementById('propRadarLeft');
    const radRight = document.getElementById('propRadarRight');
    
    // RGB Inputs
    const rL = document.getElementById('radL_R'), gL = document.getElementById('radL_G'), bL = document.getElementById('radL_B');
    const rR = document.getElementById('radR_R'), gR = document.getElementById('radR_G'), bR = document.getElementById('radR_B');

    const updateFromRGB = (isLeft) => {
        const clamp = (v) => Math.max(0, Math.min(255, parseInt(v) || 0));
        const rVal = isLeft ? clamp(rL.value) : clamp(rR.value);
        const gVal = isLeft ? clamp(gL.value) : clamp(gR.value);
        const bVal = isLeft ? clamp(bL.value) : clamp(bR.value);
        pushHistory();
        if (state.tileSelection.size > 1) {
            for (const sIdx of state.tileSelection) {
                const h = state.tiles[sIdx]?.tileHeader;
                if (!h) continue;
                if (isLeft) {
                    h.radar_red_left = rVal; h.radar_green_left = gVal; h.radar_blue_left = bVal;
                } else {
                    h.radar_red_right = rVal; h.radar_green_right = gVal; h.radar_blue_right = bVal;
                }
            }
        } else {
            if (isLeft) {
                header.radar_red_left = rVal; header.radar_green_left = gVal; header.radar_blue_left = bVal;
            } else {
                header.radar_red_right = rVal; header.radar_green_right = gVal; header.radar_blue_right = bVal;
            }
        }
        // UI Sync
        if (isLeft) {
            if (rL) rL.value = rVal; if (gL) gL.value = gVal; if (bL) bL.value = bVal;
            if (radLeft) radLeft.value = rgbToHex(rVal, gVal, bVal);
        } else {
            if (rR) rR.value = rVal; if (gR) gR.value = gVal; if (bR) bR.value = bVal;
            if (radRight) radRight.value = rgbToHex(rVal, gVal, bVal);
        }
        renderCanvas();
        updateTileDataTable();
    };

    const updateFromPicker = (isLeft, hex) => {
        const c = hexToRgb(hex);
        pushHistory();
        if (state.tileSelection.size > 1) {
            for (const sIdx of state.tileSelection) {
                const h = state.tiles[sIdx]?.tileHeader;
                if (!h) continue;
                if (isLeft) {
                    h.radar_red_left = c.r; h.radar_green_left = c.g; h.radar_blue_left = c.b;
                } else {
                    h.radar_red_right = c.r; h.radar_green_right = c.g; h.radar_blue_right = c.b;
                }
            }
        } else {
            if (isLeft) {
                header.radar_red_left = c.r; header.radar_green_left = c.g; header.radar_blue_left = c.b;
            } else {
                header.radar_red_right = c.r; header.radar_green_right = c.g; header.radar_blue_right = c.b;
            }
        }
        // UI Sync
        if (isLeft) {
            if (rL) rL.value = c.r; if (gL) gL.value = c.g; if (bL) bL.value = c.b;
        } else {
            if (rR) rR.value = c.r; if (gR) gR.value = c.g; if (bR) bR.value = c.b;
        }
        renderCanvas();
        updateTileDataTable();
    };

    if (rL) rL.onchange = () => updateFromRGB(true);
    if (gL) gL.onchange = () => updateFromRGB(true);
    if (bL) bL.onchange = () => updateFromRGB(true);
    if (rR) rR.onchange = () => updateFromRGB(false);
    if (gR) gR.onchange = () => updateFromRGB(false);
    if (bR) bR.onchange = () => updateFromRGB(false);

    if (radLeft)  radLeft.onchange  = (e) => updateFromPicker(true, e.target.value);
    if (radRight) radRight.onchange = (e) => updateFromPicker(false, e.target.value);

    // ---- Extra data movement (independent) ----
    if (hasExtra) {
        const applyExtraMove = (dxWorld, dyWorld) => {
            if (state.bondSelection) {
                // If Bond is on, base buttons move both, but extra buttons move ONLY extra
                if (state.tileSelection.size > 1) {
                    moveSelectedExtraPixels(dxWorld, dyWorld);
                } else {
                    pushHistory();
                    moveExtraBy(idx, dxWorld, dyWorld);
                    recomputeWorldBoundsFromState();
                    renderCanvas();
                    updateTileProperties();
                }
            } else {
                // Decoupled: move what is selected in subSelection
                if (state.subSelection.size > 1) {
                    moveSelectedExtraPixels(dxWorld, dyWorld);
                } else {
                    pushHistory();
                    moveExtraBy(idx, dxWorld, dyWorld);
                    recomputeWorldBoundsFromState();
                    renderCanvas();
                    updateTileProperties();
                }
            }
        };

        if (inpExX) {
            const multiEx = state.bondSelection ? (state.tileSelection.size > 1) : (state.subSelection.size > 1);
            inpExX.disabled = multiEx;
            inpExX.onchange = (e) => { const d = (parseInt(e.target.value)||0) - header.x_extra; if (d) applyExtraMove(d, 0); };
        }
        if (inpExY) {
            const multiEx = state.bondSelection ? (state.tileSelection.size > 1) : (state.subSelection.size > 1);
            inpExY.disabled = multiEx;
            inpExY.onchange = (e) => { const d = (parseInt(e.target.value)||0) - header.y_extra; if (d) applyExtraMove(0, d); };
        }

        const bExXm = document.getElementById('btnPropExXMinus');
        const bExXp = document.getElementById('btnPropExXPlus');
        const bExYm = document.getElementById('btnPropExYMinus');
        const bExYp = document.getElementById('btnPropExYPlus');
        if (bExXm) setupAutoRepeat(bExXm, (e) => applyExtraMove(-(e.ctrlKey ? bigStep : 1), 0));
        if (bExXp) setupAutoRepeat(bExXp, (e) => applyExtraMove(+(e.ctrlKey ? bigStep : 1), 0));
        if (bExYm) setupAutoRepeat(bExYm, (e) => applyExtraMove(0, -(e.ctrlKey ? bigStep : 1)));
        if (bExYp) setupAutoRepeat(bExYp, (e) => applyExtraMove(0, +(e.ctrlKey ? bigStep : 1), 0));
    }

    // Refresh canvas size if properties panel visibility changed to avoid scrollbars
    if (elements.panelRight && elements.panelRight.style.display !== prevDisplay) {
        updateCanvasSize();
        renderCanvas();
    }
    
    // Refresh Data Table in live
    updateTileDataTable();
}

/**
 * Imports Z-Data from a given File object into a specific tile.
 * @param {File} file 
 * @param {string} type - 'base' or 'extra'
 * @param {number} tileIdx - state.tiles index
 */
export function importSurfaceData(file, type, tileIdx) {
    const reader = new FileReader();
    reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
            const tile = state.tiles[tileIdx];
            if (!tile) return;
            const h = tile.tileHeader;
            
            const imgW = img.width;
            const imgH = img.height;

            // Strict check for Base Data
            if (type === 'base') {
                if (imgW !== state.cx || imgH !== state.cy) {
                    showPasteNotification(`Failed: Base Image MUST be ${state.cx}x${state.cy}. (Pasted: ${imgW}x${imgH})`, 'error');
                    return;
                }
            } else {
                // Update header to match the NEW image size
                if (!h) tile.tileHeader = { has_extra_data: 1, x_extra: 0, y_extra: 0 };
                tile.tileHeader.cx_extra = imgW;
                tile.tileHeader.cy_extra = imgH;
                tile.tileHeader.has_extra_data = 1;
            }

            const canvas = document.createElement('canvas');
            canvas.width = imgW; canvas.height = imgH;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, imgW, imgH);
            const imgData = ctx.getImageData(0, 0, imgW, imgH).data;
            const out = new Uint8Array(imgW * imgH);
            for (let i=0; i < out.length; i++) {
                const r = imgData[i*4], g = imgData[i*4+1], b = imgData[i*4+2], a = imgData[i*4+3];
                if (a < 128) out[i] = TRANSPARENT_COLOR;
                else out[i] = findNearestPaletteIndex(r, g, b, state.palette);
            }
            pushHistory();
            if (type === 'base') tile.data = out;
            else tile.extraImageData = out;
            
            updateTileProperties();
            renderCanvas();
            updateTilesList();
            updateMismatchNotification();
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

export function importZData(file, type, tileIdx) {
    const reader = new FileReader();
    reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
            const tile = state.tiles[tileIdx];
            if (!tile) return;
            
            const imgW = img.width;
            const imgH = img.height;

            // Strict check for Base Z
            if (type === 'base') {
                if (imgW !== state.cx || imgH !== state.cy) {
                    showPasteNotification(`Failed: Base Z-Data must be ${state.cx}x${state.cy}. Found ${imgW}x${imgH}.`, 'error');
                    return;
                }
            } else {
                // If extra data, we AUTO-RESIZE the attachment to fit the new Z-data
                if (!tile.tileHeader) tile.tileHeader = { has_extra_data: 1, x_extra: 0, y_extra: 0 };
                tile.tileHeader.cx_extra = imgW;
                tile.tileHeader.cy_extra = imgH;
                tile.tileHeader.has_extra_data = 1;
            }

            const canvas = document.createElement('canvas');
            canvas.width = imgW;
            canvas.height = imgH;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, imgW, imgH);
            
            const imgData = ctx.getImageData(0, 0, imgW, imgH);
            const pixels = imgData.data;
            const zOut = new Uint8Array(imgW * imgH);
            
            for (let i = 0; i < zOut.length; i++) {
                // Using Red channel (grayscale standard)
                const r = pixels[i * 4];
                const a = pixels[i * 4 + 3];

                // If fully transparent, default to 0
                if (a < 128) {
                    zOut[i] = 0;
                } else {
                    // Convert back from 0-255 mapped value to 0-31 index
                    // Since XCC uses (index * 255 / 31) for generating grayscale preview colors
                    zOut[i] = Math.round((r * 31) / 255);
                }
            }
            
            pushHistory();
            if (type === 'base') {
                if (imgW !== state.cx || imgH !== state.cy) {
                    showPasteNotification(`Failed: Base Z-Data MUST be ${state.cx}x${state.cy}. (Pasted: ${imgW}x${imgH})`, 'error');
                    return;
                }
                tile.zData = zOut;
                tile.tileHeader.has_z_data = true;
                tile.tileHeader.flags |= 0x02; // Set Z bit
            } else {
                tile.extraZData = zOut;
                tile.tileHeader.has_z_data = true;
                tile.tileHeader.flags |= 0x02;
            }
            
            updateTileProperties();
            renderCanvas();
            updateTilesList();
            updateMismatchNotification();
            console.log(`[UI] Z-Data (${type}) imported for tile ${tileIdx}`);
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

/**
 * Rapidly syncs the "overlapping" class for all items in the tile list
 * without fully re-rendering the list. Useful for dragging/keyboard move.
 */
export function syncListOverlaps() {
    const list = document.getElementById('tilesList');
    if (!list) return;
    const items = list.querySelectorAll('.layer-item');
    items.forEach(item => {
        const idx = parseInt(item.dataset.idx);
        const subType = item.dataset.subType;
        const tile = state.tiles[idx];
        const overlap = state.overlappingTiles && state.overlappingTiles.has(idx);
        const mismatch = (subType === 'extra' && _isExtraDataMismatched(tile));

        item.classList.toggle('overlapping', overlap);
        item.classList.toggle('mismatch-error', mismatch);
    });

    // Also sync the Data Table if visible
    const tableBody = elements.tileDataTableBody;
    if (tableBody && elements.tileDataTablePanel && elements.tileDataTablePanel.style.display !== 'none') {
        const rows = tableBody.querySelectorAll('.data-table-row');
        rows.forEach(row => {
            const idx = parseInt(row.dataset.idx);
            const tile = state.tiles[idx];
            const overlap = state.overlappingTiles && state.overlappingTiles.has(idx);
            const mismatch = _isExtraDataMismatched(tile);

            row.classList.toggle('overlapping', overlap);
            row.classList.toggle('mismatch-error', mismatch);
        });
    }

    if (window.renderTabs) {
        window.renderTabs();
    }
}

/**
 * Populates the Tile Data Table with information from the current project.
 */
export function updateTileDataTable() {
    const tableBody = elements.tileDataTableBody;
    const countDisplay = elements.tileDataTableCount;
    if (!tableBody || !state.tmpData) return;

    // We MUST re-calculate the displayIdx exactly as _updateTilesListImmediate does
    // to ensure the indices match the left sidebar.
    // Use exactly the same filtering as updateTilesList so indices match the sidebar
    const populated = state.tiles
        .map((tile, originalIdx) => ({ tile, originalIdx }))
        .filter(item => item.tile && item.tile.tileHeader !== null);

    const allDisplayItems = [];
    populated.forEach((info, displayIdx) => {
        // ONE row per tile index to match Open TMP style
        allDisplayItems.push({ ...info, displayIdx, key: `${info.originalIdx}` });
    });

    const chkOnlySelected = document.getElementById('chkShowOnlySelectedCells');
    const showOnlySelected = chkOnlySelected ? chkOnlySelected.checked : false;

    // Attach listener once if not already done
    if (chkOnlySelected && !chkOnlySelected.dataset.listener) {
        chkOnlySelected.dataset.listener = "true";
        chkOnlySelected.onchange = () => updateTileDataTable();
    }

    let displayItems;
    if (showOnlySelected) {
        displayItems = allDisplayItems.filter(it => state.tileSelection.has(it.originalIdx));
    } else {
        displayItems = allDisplayItems;
    }

    if (countDisplay) {
        const selectedCount = allDisplayItems.filter(it => state.tileSelection.has(it.originalIdx)).length;
        if (showOnlySelected) {
            countDisplay.innerText = t('msg_filtered_count').replace('{{count}}', displayItems.length);
        } else {
            countDisplay.innerText = selectedCount > 0 
                ? t('msg_selected_total_count').replace('{{selected}}', selectedCount).replace('{{total}}', allDisplayItems.length) 
                : t('msg_total_count').replace('{{total}}', allDisplayItems.length);
        }
    }
    
    // Only do DOM work if visible
    const isVisible = elements.tileDataTablePanel && elements.tileDataTablePanel.style.display !== 'none';
    if (!isVisible) return; 

    if (displayItems.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="8" style="padding: 30px; text-align: center; color: #718096; font-style: italic; font-size: 12px; background: #16171d;">No cell data found in this project</td></tr>`;
        return;
    }

    tableBody.innerHTML = displayItems
        .map(it => {
            const { tile, originalIdx, displayIdx } = it;
            const h = tile.tileHeader;
            const isRowActive = (state.currentTileIdx === originalIdx);
            const isOverlapping = state.overlappingTiles && state.overlappingTiles.has(originalIdx);
            
            const isSelected = state.tileSelection.has(originalIdx);
            const isMismatch = _isExtraDataMismatched(tile);
            
            // Highlight all selected rows with the same professional blue tone
            let rowStyle = isSelected ? 'background: rgba(66, 153, 225, 0.3);' : '';
            
            const rowClasses = [
                'data-table-row',
                isOverlapping ? 'overlapping' : '',
                isMismatch ? 'mismatch-error' : '',
                isSelected ? 'selected' : '',
                isRowActive ? 'active' : ''
            ].filter(Boolean).join(' ');
            
            // Format Extra info
            const hasEx = h.has_extra_data;
            const exX = hasEx ? h.x_extra : '-';
            const exY = hasEx ? h.y_extra : '-';

            return `<tr data-idx="${originalIdx}" style="cursor: pointer; ${rowStyle} border-bottom: 1px solid #111;" class="${rowClasses}">
                <td style="padding: 6px 8px; color: #fff; font-size: 13px; font-weight: 700;">${displayIdx}</td>
                <td style="padding: 6px 8px; font-family: monospace; color: #cbd5e0; font-size: 13px;">${h.x}</td>
                <td style="padding: 6px 8px; font-family: monospace; color: #cbd5e0; font-size: 13px;">${h.y}</td>
                <td style="padding: 6px 8px; font-family: monospace; color: #fff; font-size: 13px;">${h.height}</td>
                <td style="padding: 6px 8px; font-family: monospace; color: #00ff9d; font-size: 13px;">${exX}</td>
                <td style="padding: 6px 8px; font-family: monospace; color: #00ff9d; font-size: 13px;">${exY}</td>
                <td style="padding: 6px 8px; color: #fff; font-size: 13px;">${h.land_type} - ${getLandTypeName(h.land_type)}</td>
                <td style="padding: 6px 8px; color: #fff; font-size: 13px;">${h.ramp_type} - ${getRampTypeName(h.ramp_type)}</td>
            </tr>`;
        }).join('');

    // Selection handlers from table
    const rows = tableBody.querySelectorAll('.data-table-row');
    rows.forEach(row => {
        row.onclick = (e) => {
            const idx = parseInt(row.dataset.idx);
            const isCtrl = e.ctrlKey || e.metaKey;
            const isShift = e.shiftKey;
            selectTilePart(idx, 'base', isCtrl, isShift);
        };
    });
}

// Expose utilities for main context menu
window._uiUtils = { getPos, pickTileIndexAt, selectTileAt };

// Z-Data Depth Ranges (Subsets for procedural generation)
const TS_Z_DEPTH_MIN = 13;
const TS_Z_DEPTH_MAX = 24;
const RA2_Z_DEPTH_MIN = 15; 
const RA2_Z_DEPTH_MAX = 30; 

/**
 * Generates Z-Data for selected tiles using a procedural gradient.
 * @param {string} mode - 'vdown', 'vup', 'hright', 'hleft', 'mirrorv', 'mirrorh'
 */
export function generateZDataForSelectedTiles(mode = 'vdown') {
    if (state.tileSelection.size === 0) return;

    // Use game-specific depth ranges
    const gt = state.gameType || 'ts';
    const zMin = (gt === 'ra2') ? RA2_Z_DEPTH_MIN : TS_Z_DEPTH_MIN;
    const zMax = (gt === 'ra2') ? RA2_Z_DEPTH_MAX : TS_Z_DEPTH_MAX;
    const zRange = zMax - zMin;

    const updatedIndices = [];
    for (const idx of state.tileSelection) {
        const t = state.tiles[idx];
        if (t && t.tileHeader && t.tileHeader.has_extra_data && t.extraImageData && t.extraZData) {
            const buffer = t.extraImageData;
            const cx = t._extraImg_cx || t.tileHeader.cx_extra;
            const cy = t._extraImg_cy || t.tileHeader.cy_extra;
            
            const newZBuffer = new Uint8Array(buffer.length).fill(255);

            for (let i = 0; i < buffer.length; i++) {
                const colorIdx = buffer[i];
                if (colorIdx === 0) {
                    newZBuffer[i] = 255; // Transparency / No Depth
                } else {
                    const px = i % cx;
                    const py = Math.floor(i / cx);
                    let factor = 0.5;

                    switch (mode) {
                        case 'vdown':
                            factor = cy > 1 ? (py / (cy - 1)) : 0;
                            break;
                        case 'vup':
                            factor = cy > 1 ? (1 - (py / (cy - 1))) : 0;
                            break;
                        case 'hright':
                            factor = cx > 1 ? (px / (cx - 1)) : 0;
                            break;
                        case 'hleft':
                            factor = cx > 1 ? (1 - (px / (cx - 1))) : 0;
                            break;
                        case 'mirrorv':
                            if (cy > 1) {
                                const mid = (cy - 1) / 2;
                                factor = Math.abs(py - mid) / mid;
                            } else factor = 0;
                            break;
                        case 'mirrorv_inv':
                            if (cy > 1) {
                                const mid = (cy - 1) / 2;
                                factor = 1 - (Math.abs(py - mid) / mid);
                            } else factor = 0;
                            break;
                        case 'mirrorh':
                            if (cx > 1) {
                                const mid = (cx - 1) / 2;
                                factor = Math.abs(px - mid) / mid;
                            } else factor = 0;
                            break;
                        case 'mirrorh_inv':
                            if (cx > 1) {
                                const mid = (cx - 1) / 2;
                                factor = 1 - (Math.abs(px - mid) / mid);
                            } else factor = 0;
                            break;
                    }
                    
                    const curvedFactor = Math.pow(factor, 0.9);
                    newZBuffer[i] = Math.max(zMin, Math.min(zMax, Math.floor(zMin + curvedFactor * zRange)));
                }
            }
            // Update tile with new synchronized Z-Data
            t.extraZData = newZBuffer;
            t._extraZ_cx = cx;
            t._extraZ_cy = cy;
            
            // Recompute bounds if function is available globally
            if (window.recomputeTileStateBounds) window.recomputeTileStateBounds(t);

            updatedIndices.push(idx);
        }
    }

    if (updatedIndices.length > 0) {
        pushHistory(updatedIndices);
        renderCanvas();
        updateTilesList();
        updateMismatchNotification(); // Re-evaluate mismatch state: sizes now match, clear the red alert
    }
}
