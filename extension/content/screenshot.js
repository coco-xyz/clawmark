/**
 * ClawMark — Screenshot Capture + Annotation (v2 — Layer-based)
 *
 * Flow:
 * 1. Capture visible tab via service worker
 * 2. Show area selection overlay with adjustable handles
 * 3. Crop selected area
 * 4. Show annotation editor (select, pen, arrow, rectangle, circle, text, number)
 *    - All annotations are objects that can be selected, moved, and deleted
 * 5. Export annotated image for upload
 *
 * #111 — WeChat-style screenshot UX with draggable annotations
 */

'use strict';

(() => {
    if (window.__clawmarkScreenshot) return;
    window.__clawmarkScreenshot = true;

    // ----------------------------------------------------------- constants

    const COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#ffffff'];
    const LINE_WIDTH = 3;
    const HIT_TOLERANCE = 8;      // px tolerance for selecting annotations
    const HANDLE_SIZE = 8;        // selection handle size
    const MIN_SHAPE_SIZE = 5;     // minimum shape size to commit
    const NUMBER_RADIUS = 14;     // numbered marker circle radius

    // ----------------------------------------------------------- state

    let fullImage = null;         // Image element of full tab capture
    let cropRect = null;          // { x, y, w, h } from area selection
    let tool = 'select';          // select | pen | arrow | rect | circle | text | number
    let color = '#ef4444';        // drawing color
    let annotations = [];         // annotation objects (the layer stack)
    let selectedIdx = -1;         // index of selected annotation (-1 = none)
    let isDrawing = false;
    let isDragging = false;       // dragging a selected annotation
    let dragOffset = null;        // { dx, dy } offset from annotation origin to mouse
    let startPos = null;
    let onComplete = null;        // callback(dataUrl) when user finishes
    let numberCounter = 1;        // auto-incrementing number marker

    // ----------------------------------------------------------- public API

    window.__clawmarkStartScreenshot = function (callback) {
        onComplete = callback;
        startCapture();
    };

    // ----------------------------------------------------------- capture

    async function startCapture() {
        try {
            const result = await chrome.runtime.sendMessage({ type: 'CAPTURE_TAB' });
            if (result.error) throw new Error(result.error);

            fullImage = new Image();
            fullImage.onload = () => showAreaSelector();
            fullImage.src = result.dataUrl;
        } catch (err) {
            console.error('[ClawMark] Screenshot capture failed:', err);
            if (onComplete) onComplete(null);
        }
    }

    // ----------------------------------------------------------- area selector

    let selectorOverlay = null;
    let selBox = null;
    let selStart = null;
    let selRect = null;           // current visual selection { x, y, w, h } in CSS px
    let selPhase = 'draw';        // draw | adjust
    let selDragType = null;       // null | 'move' | handle name
    let selDragStart = null;

    function showAreaSelector() {
        selectorOverlay = document.createElement('div');
        selectorOverlay.id = 'clawmark-area-selector';
        selectorOverlay.innerHTML = `
            <div class="cm-sel-hint">Click and drag to select area. Press Esc to cancel.</div>
            <div class="cm-sel-box" id="cm-sel-box">
                <div class="cm-sel-handle" data-handle="nw"></div>
                <div class="cm-sel-handle" data-handle="ne"></div>
                <div class="cm-sel-handle" data-handle="sw"></div>
                <div class="cm-sel-handle" data-handle="se"></div>
                <div class="cm-sel-handle" data-handle="n"></div>
                <div class="cm-sel-handle" data-handle="s"></div>
                <div class="cm-sel-handle" data-handle="w"></div>
                <div class="cm-sel-handle" data-handle="e"></div>
            </div>
            <div class="cm-sel-actions" id="cm-sel-actions">
                <button class="cm-sel-cancel">&#10005;</button>
                <button class="cm-sel-confirm">&#10003;</button>
            </div>
        `;
        document.body.appendChild(selectorOverlay);
        selBox = document.getElementById('cm-sel-box');
        selPhase = 'draw';
        selRect = null;

        selectorOverlay.addEventListener('mousedown', onSelStart);
        selectorOverlay.addEventListener('mousemove', onSelMove);
        selectorOverlay.addEventListener('mouseup', onSelEnd);
        document.addEventListener('keydown', onSelKey);

        // Action buttons
        const actionsEl = document.getElementById('cm-sel-actions');
        actionsEl.addEventListener('click', (e) => {
            const btn = e.target.closest('button');
            if (!btn) return;
            if (btn.classList.contains('cm-sel-confirm')) {
                confirmSelection();
            } else if (btn.classList.contains('cm-sel-cancel')) {
                removeAreaSelector();
                if (onComplete) onComplete(null);
            }
        });
    }

    function updateSelBox() {
        if (!selRect) return;
        selBox.style.display = 'block';
        selBox.style.left = selRect.x + 'px';
        selBox.style.top = selRect.y + 'px';
        selBox.style.width = selRect.w + 'px';
        selBox.style.height = selRect.h + 'px';

        // Position action buttons below selection
        const actionsEl = document.getElementById('cm-sel-actions');
        if (actionsEl) {
            actionsEl.style.display = 'flex';
            actionsEl.style.left = (selRect.x + selRect.w - actionsEl.offsetWidth) + 'px';
            actionsEl.style.top = (selRect.y + selRect.h + 8) + 'px';
        }
    }

    function onSelStart(e) {
        if (e.target.closest('.cm-sel-actions')) return;

        const handle = e.target.closest('.cm-sel-handle');
        if (handle && selPhase === 'adjust') {
            // Start resizing via handle
            selDragType = handle.dataset.handle;
            selDragStart = { x: e.clientX, y: e.clientY, rect: { ...selRect } };
            e.preventDefault();
            return;
        }

        if (selPhase === 'adjust' && selRect && isInsideRect(e.clientX, e.clientY, selRect)) {
            // Start moving the selection
            selDragType = 'move';
            selDragStart = { x: e.clientX, y: e.clientY, rect: { ...selRect } };
            e.preventDefault();
            return;
        }

        // New selection draw
        selPhase = 'draw';
        selStart = { x: e.clientX, y: e.clientY };
        selRect = { x: e.clientX, y: e.clientY, w: 0, h: 0 };
        selBox.style.display = 'block';
        const actionsEl = document.getElementById('cm-sel-actions');
        if (actionsEl) actionsEl.style.display = 'none';
    }

    function onSelMove(e) {
        if (selPhase === 'draw' && selStart) {
            selRect = normalizeRect(selStart.x, selStart.y, e.clientX, e.clientY);
            updateSelBox();
        } else if (selDragType && selDragStart) {
            const dx = e.clientX - selDragStart.x;
            const dy = e.clientY - selDragStart.y;
            const r = selDragStart.rect;

            if (selDragType === 'move') {
                selRect = { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h };
            } else {
                selRect = resizeRect(r, selDragType, dx, dy);
            }
            updateSelBox();
        }
    }

    function onSelEnd(e) {
        if (selPhase === 'draw' && selStart) {
            selRect = normalizeRect(selStart.x, selStart.y, e.clientX, e.clientY);
            selStart = null;

            if (selRect.w >= 10 && selRect.h >= 10) {
                selPhase = 'adjust';
                updateSelBox();
                // Update hint
                const hint = selectorOverlay.querySelector('.cm-sel-hint');
                if (hint) hint.textContent = 'Drag to move, handles to resize. Press Enter to confirm.';
            }
        }
        selDragType = null;
        selDragStart = null;
    }

    function onSelKey(e) {
        if (e.key === 'Escape') {
            removeAreaSelector();
            if (onComplete) onComplete(null);
        } else if (e.key === 'Enter' && selPhase === 'adjust' && selRect) {
            confirmSelection();
        }
    }

    function confirmSelection() {
        if (!selRect || selRect.w < 10 || selRect.h < 10) return;
        const dpr = window.devicePixelRatio || 1;
        cropRect = {
            x: selRect.x * dpr,
            y: selRect.y * dpr,
            w: selRect.w * dpr,
            h: selRect.h * dpr,
        };
        removeAreaSelector();
        showAnnotationEditor();
    }

    function removeAreaSelector() {
        if (selectorOverlay) {
            selectorOverlay.remove();
            selectorOverlay = null;
        }
        document.removeEventListener('keydown', onSelKey);
    }

    // ---- rect helpers

    function normalizeRect(x1, y1, x2, y2) {
        return {
            x: Math.min(x1, x2),
            y: Math.min(y1, y2),
            w: Math.abs(x2 - x1),
            h: Math.abs(y2 - y1),
        };
    }

    function isInsideRect(px, py, r) {
        return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
    }

    function resizeRect(r, handle, dx, dy) {
        let { x, y, w, h } = r;
        if (handle.includes('n')) { y += dy; h -= dy; }
        if (handle.includes('s')) { h += dy; }
        if (handle.includes('w')) { x += dx; w -= dx; }
        if (handle.includes('e')) { w += dx; }
        // Prevent negative sizes
        if (w < 20) { w = 20; }
        if (h < 20) { h = 20; }
        return { x, y, w, h };
    }

    // ----------------------------------------------------------- annotation editor

    let editorOverlay = null;
    let canvas = null;
    let ctx = null;
    let bgCanvas = null;

    function showAnnotationEditor() {
        const cw = cropRect.w;
        const ch = cropRect.h;

        // Scale to fit viewport
        const maxW = window.innerWidth * 0.85;
        const maxH = window.innerHeight * 0.75;
        const scale = Math.min(1, maxW / cw, maxH / ch);
        const dispW = Math.round(cw * scale);
        const dispH = Math.round(ch * scale);

        editorOverlay = document.createElement('div');
        editorOverlay.id = 'clawmark-annotation-editor';
        editorOverlay.innerHTML = `
            <div class="cm-ann-canvas-wrap" style="width:${dispW}px;height:${dispH}px;">
                <canvas id="cm-ann-canvas" width="${cw}" height="${ch}" style="width:${dispW}px;height:${dispH}px;"></canvas>
            </div>
            <div class="cm-ann-toolbar">
                <div class="cm-ann-tools">
                    <button class="cm-ann-tool active" data-tool="select" title="Select / Move">&#9995;</button>
                    <button class="cm-ann-tool" data-tool="rect" title="Rectangle">&#9634;</button>
                    <button class="cm-ann-tool" data-tool="circle" title="Circle">&#9898;</button>
                    <button class="cm-ann-tool" data-tool="arrow" title="Arrow">&#10148;</button>
                    <button class="cm-ann-tool" data-tool="pen" title="Pen">&#9999;&#65039;</button>
                    <button class="cm-ann-tool" data-tool="number" title="Number Marker">&#9312;</button>
                    <button class="cm-ann-tool" data-tool="text" title="Text">T</button>
                </div>
                <div class="cm-ann-separator"></div>
                <div class="cm-ann-colors">
                    ${COLORS.map(c => `<button class="cm-ann-color${c === color ? ' active' : ''}" data-color="${c}" style="background:${c}"></button>`).join('')}
                </div>
                <div class="cm-ann-separator"></div>
                <div class="cm-ann-actions">
                    <button class="cm-ann-undo" title="Undo (Ctrl+Z)">&#8617;</button>
                    <button class="cm-ann-delete" title="Delete selected (Del)">&#128465;</button>
                    <button class="cm-ann-cancel">Cancel</button>
                    <button class="cm-ann-done">Attach</button>
                </div>
            </div>
        `;
        document.body.appendChild(editorOverlay);

        canvas = document.getElementById('cm-ann-canvas');
        ctx = canvas.getContext('2d');

        // Draw cropped image
        bgCanvas = document.createElement('canvas');
        bgCanvas.width = cw;
        bgCanvas.height = ch;
        const bgCtx = bgCanvas.getContext('2d');
        bgCtx.drawImage(fullImage, cropRect.x, cropRect.y, cw, ch, 0, 0, cw, ch);
        ctx.drawImage(bgCanvas, 0, 0);

        annotations = [];
        selectedIdx = -1;
        numberCounter = 1;
        tool = 'select';
        isDrawing = false;
        isDragging = false;

        // Event listeners
        canvas.addEventListener('mousedown', onDrawStart);
        canvas.addEventListener('mousemove', onDrawMove);
        canvas.addEventListener('mouseup', onDrawEnd);
        canvas.addEventListener('mouseleave', onDrawEnd);

        const toolbar = editorOverlay.querySelector('.cm-ann-toolbar');
        toolbar.addEventListener('click', onToolbarClick);

        document.addEventListener('keydown', onEditorKey);
    }

    function getCanvasPos(e) {
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        return {
            x: (e.clientX - rect.left) * scaleX,
            y: (e.clientY - rect.top) * scaleY,
        };
    }

    // ----------------------------------------------------------- annotation bounding box / hit test

    function getAnnotationBounds(ann) {
        switch (ann.type) {
            case 'rect':
            case 'circle': {
                const x = Math.min(ann.from.x, ann.to.x);
                const y = Math.min(ann.from.y, ann.to.y);
                const w = Math.abs(ann.to.x - ann.from.x);
                const h = Math.abs(ann.to.y - ann.from.y);
                return { x, y, w, h };
            }
            case 'arrow': {
                const x = Math.min(ann.from.x, ann.to.x) - HIT_TOLERANCE;
                const y = Math.min(ann.from.y, ann.to.y) - HIT_TOLERANCE;
                const w = Math.abs(ann.to.x - ann.from.x) + HIT_TOLERANCE * 2;
                const h = Math.abs(ann.to.y - ann.from.y) + HIT_TOLERANCE * 2;
                return { x, y, w, h };
            }
            case 'pen': {
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                for (const p of ann.points) {
                    if (p.x < minX) minX = p.x;
                    if (p.y < minY) minY = p.y;
                    if (p.x > maxX) maxX = p.x;
                    if (p.y > maxY) maxY = p.y;
                }
                return { x: minX - HIT_TOLERANCE, y: minY - HIT_TOLERANCE, w: maxX - minX + HIT_TOLERANCE * 2, h: maxY - minY + HIT_TOLERANCE * 2 };
            }
            case 'text': {
                ctx.font = 'bold 20px sans-serif';
                const metrics = ctx.measureText(ann.text);
                return { x: ann.pos.x - 2, y: ann.pos.y - 20, w: metrics.width + 4, h: 26 };
            }
            case 'number': {
                const r = NUMBER_RADIUS;
                return { x: ann.pos.x - r, y: ann.pos.y - r, w: r * 2, h: r * 2 };
            }
            default:
                return { x: 0, y: 0, w: 0, h: 0 };
        }
    }

    function hitTest(pos) {
        // Reverse order: top-most annotation first
        for (let i = annotations.length - 1; i >= 0; i--) {
            const bounds = getAnnotationBounds(annotations[i]);
            if (pos.x >= bounds.x - HIT_TOLERANCE &&
                pos.x <= bounds.x + bounds.w + HIT_TOLERANCE &&
                pos.y >= bounds.y - HIT_TOLERANCE &&
                pos.y <= bounds.y + bounds.h + HIT_TOLERANCE) {
                return i;
            }
        }
        return -1;
    }

    // ----------------------------------------------------------- move annotations

    function moveAnnotation(ann, dx, dy) {
        switch (ann.type) {
            case 'rect':
            case 'circle':
            case 'arrow':
                ann.from = { x: ann.from.x + dx, y: ann.from.y + dy };
                ann.to = { x: ann.to.x + dx, y: ann.to.y + dy };
                break;
            case 'pen':
                for (const p of ann.points) {
                    p.x += dx;
                    p.y += dy;
                }
                break;
            case 'text':
            case 'number':
                ann.pos = { x: ann.pos.x + dx, y: ann.pos.y + dy };
                break;
        }
    }

    // ----------------------------------------------------------- drawing input

    function onDrawStart(e) {
        const pos = getCanvasPos(e);
        startPos = pos;

        if (tool === 'select') {
            const hit = hitTest(pos);
            selectedIdx = hit;
            if (hit >= 0) {
                // Start dragging
                isDragging = true;
                const bounds = getAnnotationBounds(annotations[hit]);
                dragOffset = { dx: pos.x - bounds.x, dy: pos.y - bounds.y };
            }
            redraw();
            return;
        }

        // Deselect when switching to a drawing tool
        selectedIdx = -1;
        isDrawing = true;

        if (tool === 'pen') {
            annotations.push({ type: 'pen', color, points: [pos] });
        } else if (tool === 'text') {
            isDrawing = false;
            showTextInput(pos);
        } else if (tool === 'number') {
            isDrawing = false;
            annotations.push({ type: 'number', color, pos, num: numberCounter++ });
            redraw();
        }
    }

    function onDrawMove(e) {
        const pos = getCanvasPos(e);

        if (isDragging && selectedIdx >= 0) {
            const bounds = getAnnotationBounds(annotations[selectedIdx]);
            const dx = pos.x - bounds.x - dragOffset.dx;
            const dy = pos.y - bounds.y - dragOffset.dy;
            moveAnnotation(annotations[selectedIdx], dx, dy);
            redraw();
            return;
        }

        if (!isDrawing) {
            // Update cursor for select tool
            if (tool === 'select') {
                const hit = hitTest(pos);
                canvas.style.cursor = hit >= 0 ? 'move' : 'default';
            }
            return;
        }

        if (tool === 'pen') {
            const ann = annotations[annotations.length - 1];
            ann.points.push(pos);
            redraw();
        } else if (tool === 'arrow' || tool === 'rect' || tool === 'circle') {
            // Live preview
            redraw();
            drawShapeOnCtx(tool, startPos, pos, color, false);
        }
    }

    function onDrawEnd(e) {
        if (isDragging) {
            isDragging = false;
            dragOffset = null;
            return;
        }

        if (!isDrawing) return;
        isDrawing = false;
        const pos = getCanvasPos(e);

        if (tool === 'arrow' || tool === 'rect' || tool === 'circle') {
            const dx = Math.abs(pos.x - startPos.x);
            const dy = Math.abs(pos.y - startPos.y);
            if (dx >= MIN_SHAPE_SIZE || dy >= MIN_SHAPE_SIZE) {
                annotations.push({ type: tool, color, from: { ...startPos }, to: pos });
            }
            redraw();
        }
        startPos = null;
    }

    // ----------------------------------------------------------- text input (inline, no prompt())

    let textInputEl = null;

    function showTextInput(pos) {
        if (textInputEl) textInputEl.remove();

        const rect = canvas.getBoundingClientRect();
        const scaleX = rect.width / canvas.width;
        const scaleY = rect.height / canvas.height;

        textInputEl = document.createElement('input');
        textInputEl.type = 'text';
        textInputEl.className = 'cm-ann-text-input';
        textInputEl.style.left = (rect.left + pos.x * scaleX) + 'px';
        textInputEl.style.top = (rect.top + pos.y * scaleY - 12) + 'px';
        textInputEl.style.color = color;
        textInputEl.placeholder = 'Type text...';

        const commitText = () => {
            const text = textInputEl.value.trim();
            if (text) {
                annotations.push({ type: 'text', color, pos: { ...pos }, text });
                redraw();
            }
            textInputEl.remove();
            textInputEl = null;
        };

        textInputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commitText(); }
            if (e.key === 'Escape') { textInputEl.remove(); textInputEl = null; }
            e.stopPropagation();
        });
        textInputEl.addEventListener('blur', commitText);

        editorOverlay.appendChild(textInputEl);
        textInputEl.focus();
    }

    // ----------------------------------------------------------- redraw

    function redraw() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bgCanvas, 0, 0);

        for (let i = 0; i < annotations.length; i++) {
            const ann = annotations[i];
            renderAnnotation(ann);
        }

        // Draw selection highlight
        if (selectedIdx >= 0 && selectedIdx < annotations.length) {
            const bounds = getAnnotationBounds(annotations[selectedIdx]);
            ctx.save();
            ctx.strokeStyle = '#5865f2';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 4]);
            ctx.strokeRect(bounds.x - 3, bounds.y - 3, bounds.w + 6, bounds.h + 6);
            ctx.setLineDash([]);

            // Corner handles
            const hs = HANDLE_SIZE;
            ctx.fillStyle = '#5865f2';
            ctx.fillRect(bounds.x - 3 - hs / 2, bounds.y - 3 - hs / 2, hs, hs);
            ctx.fillRect(bounds.x + bounds.w + 3 - hs / 2, bounds.y - 3 - hs / 2, hs, hs);
            ctx.fillRect(bounds.x - 3 - hs / 2, bounds.y + bounds.h + 3 - hs / 2, hs, hs);
            ctx.fillRect(bounds.x + bounds.w + 3 - hs / 2, bounds.y + bounds.h + 3 - hs / 2, hs, hs);
            ctx.restore();
        }

        // Update cursor
        if (tool !== 'select') {
            canvas.style.cursor = 'crosshair';
        }
    }

    function renderAnnotation(ann) {
        switch (ann.type) {
            case 'pen':
                drawPen(ann.points, ann.color);
                break;
            case 'arrow':
                drawShapeOnCtx('arrow', ann.from, ann.to, ann.color, false);
                break;
            case 'rect':
                drawShapeOnCtx('rect', ann.from, ann.to, ann.color, false);
                break;
            case 'circle':
                drawShapeOnCtx('circle', ann.from, ann.to, ann.color, false);
                break;
            case 'text':
                drawText(ann.text, ann.pos, ann.color);
                break;
            case 'number':
                drawNumber(ann.num, ann.pos, ann.color);
                break;
        }
    }

    function drawPen(points, c) {
        if (points.length < 2) return;
        ctx.strokeStyle = c;
        ctx.lineWidth = LINE_WIDTH;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
            ctx.lineTo(points[i].x, points[i].y);
        }
        ctx.stroke();
    }

    function drawShapeOnCtx(type, from, to, c, preview) {
        ctx.strokeStyle = c;
        ctx.lineWidth = LINE_WIDTH;
        ctx.lineCap = 'round';

        if (type === 'rect') {
            ctx.strokeRect(from.x, from.y, to.x - from.x, to.y - from.y);
        } else if (type === 'circle') {
            const cx = (from.x + to.x) / 2;
            const cy = (from.y + to.y) / 2;
            const rx = Math.abs(to.x - from.x) / 2;
            const ry = Math.abs(to.y - from.y) / 2;
            ctx.beginPath();
            ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
            ctx.stroke();
        } else if (type === 'arrow') {
            ctx.beginPath();
            ctx.moveTo(from.x, from.y);
            ctx.lineTo(to.x, to.y);
            ctx.stroke();

            // Arrowhead
            const angle = Math.atan2(to.y - from.y, to.x - from.x);
            const headLen = 15;
            ctx.beginPath();
            ctx.moveTo(to.x, to.y);
            ctx.lineTo(to.x - headLen * Math.cos(angle - Math.PI / 6), to.y - headLen * Math.sin(angle - Math.PI / 6));
            ctx.moveTo(to.x, to.y);
            ctx.lineTo(to.x - headLen * Math.cos(angle + Math.PI / 6), to.y - headLen * Math.sin(angle + Math.PI / 6));
            ctx.stroke();
        }
    }

    function drawText(text, pos, c) {
        ctx.font = 'bold 20px sans-serif';
        ctx.fillStyle = c;
        ctx.fillText(text, pos.x, pos.y);
    }

    function drawNumber(num, pos, c) {
        const r = NUMBER_RADIUS;
        // Filled circle
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
        ctx.fillStyle = c;
        ctx.fill();
        // Number text
        ctx.font = 'bold 14px sans-serif';
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(num), pos.x, pos.y);
        // Reset alignment
        ctx.textAlign = 'start';
        ctx.textBaseline = 'alphabetic';
    }

    // ----------------------------------------------------------- toolbar

    function onToolbarClick(e) {
        const btn = e.target.closest('button');
        if (!btn) return;

        if (btn.dataset.tool) {
            tool = btn.dataset.tool;
            if (tool !== 'select') selectedIdx = -1;
            editorOverlay.querySelectorAll('.cm-ann-tool').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            redraw();
        } else if (btn.dataset.color) {
            color = btn.dataset.color;
            editorOverlay.querySelectorAll('.cm-ann-color').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            // Update selected annotation's color
            if (selectedIdx >= 0) {
                annotations[selectedIdx].color = color;
                redraw();
            }
        } else if (btn.classList.contains('cm-ann-undo')) {
            undoAction();
        } else if (btn.classList.contains('cm-ann-delete')) {
            deleteSelected();
        } else if (btn.classList.contains('cm-ann-cancel')) {
            closeEditor();
            if (onComplete) onComplete(null);
        } else if (btn.classList.contains('cm-ann-done')) {
            // Clear selection before export so handles don't appear
            selectedIdx = -1;
            redraw();
            const dataUrl = canvas.toDataURL('image/png');
            closeEditor();
            if (onComplete) onComplete(dataUrl);
        }
    }

    function undoAction() {
        if (annotations.length > 0) {
            annotations.pop();
            selectedIdx = -1;
            redraw();
        }
    }

    function deleteSelected() {
        if (selectedIdx >= 0 && selectedIdx < annotations.length) {
            annotations.splice(selectedIdx, 1);
            selectedIdx = -1;
            redraw();
        }
    }

    function onEditorKey(e) {
        // Don't capture when typing in text input
        if (textInputEl && document.activeElement === textInputEl) return;

        if (e.key === 'Escape') {
            if (selectedIdx >= 0) {
                selectedIdx = -1;
                redraw();
            } else {
                closeEditor();
                if (onComplete) onComplete(null);
            }
        } else if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
            e.preventDefault();
            undoAction();
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
            if (selectedIdx >= 0) {
                e.preventDefault();
                deleteSelected();
            }
        }
    }

    function closeEditor() {
        if (textInputEl) { textInputEl.remove(); textInputEl = null; }
        if (editorOverlay) {
            editorOverlay.remove();
            editorOverlay = null;
        }
        canvas = null;
        ctx = null;
        bgCanvas = null;
        fullImage = null;
        annotations = [];
        selectedIdx = -1;
        document.removeEventListener('keydown', onEditorKey);
    }
})();
