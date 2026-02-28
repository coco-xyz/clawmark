/**
 * ClawMark — Screenshot Capture + Annotation
 *
 * Flow:
 * 1. Capture visible tab via service worker
 * 2. Show area selection overlay
 * 3. Crop selected area
 * 4. Show annotation editor (pen, arrow, rectangle, text)
 * 5. Export annotated image for upload
 */

'use strict';

(() => {
    if (window.__clawmarkScreenshot) return;
    window.__clawmarkScreenshot = true;

    // ----------------------------------------------------------- state

    let fullImage = null;   // Image element of full tab capture
    let cropRect = null;    // { x, y, w, h } from area selection
    let tool = 'pen';       // pen | arrow | rect | text
    let color = '#ef4444';  // drawing color
    let drawActions = [];   // undo stack
    let isDrawing = false;
    let startPos = null;
    let onComplete = null;  // callback(dataUrl) when user finishes

    const COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#ffffff'];

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

    function showAreaSelector() {
        selectorOverlay = document.createElement('div');
        selectorOverlay.id = 'clawmark-area-selector';
        selectorOverlay.innerHTML = `
            <div class="cm-sel-hint">Click and drag to select area. Press Esc to cancel.</div>
            <div class="cm-sel-box" id="cm-sel-box"></div>
        `;
        document.body.appendChild(selectorOverlay);
        selBox = document.getElementById('cm-sel-box');

        selectorOverlay.addEventListener('mousedown', onSelStart);
        selectorOverlay.addEventListener('mousemove', onSelMove);
        selectorOverlay.addEventListener('mouseup', onSelEnd);
        document.addEventListener('keydown', onSelKey);
    }

    function onSelStart(e) {
        selStart = { x: e.clientX, y: e.clientY };
        selBox.style.display = 'block';
        selBox.style.left = e.clientX + 'px';
        selBox.style.top = e.clientY + 'px';
        selBox.style.width = '0';
        selBox.style.height = '0';
    }

    function onSelMove(e) {
        if (!selStart) return;
        const x = Math.min(selStart.x, e.clientX);
        const y = Math.min(selStart.y, e.clientY);
        const w = Math.abs(e.clientX - selStart.x);
        const h = Math.abs(e.clientY - selStart.y);
        selBox.style.left = x + 'px';
        selBox.style.top = y + 'px';
        selBox.style.width = w + 'px';
        selBox.style.height = h + 'px';
    }

    function onSelEnd(e) {
        if (!selStart) return;
        const dpr = window.devicePixelRatio || 1;
        const x = Math.min(selStart.x, e.clientX) * dpr;
        const y = Math.min(selStart.y, e.clientY) * dpr;
        const w = Math.abs(e.clientX - selStart.x) * dpr;
        const h = Math.abs(e.clientY - selStart.y) * dpr;
        selStart = null;

        removeAreaSelector();

        if (w < 10 || h < 10) {
            // Too small — treat as full page
            cropRect = { x: 0, y: 0, w: fullImage.naturalWidth, h: fullImage.naturalHeight };
        } else {
            cropRect = { x, y, w, h };
        }

        showAnnotationEditor();
    }

    function onSelKey(e) {
        if (e.key === 'Escape') {
            removeAreaSelector();
            if (onComplete) onComplete(null);
        }
    }

    function removeAreaSelector() {
        if (selectorOverlay) {
            selectorOverlay.remove();
            selectorOverlay = null;
        }
        document.removeEventListener('keydown', onSelKey);
    }

    // ----------------------------------------------------------- annotation editor

    let editorOverlay = null;
    let canvas = null;
    let ctx = null;
    let bgCanvas = null; // stores the cropped image + committed drawings

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
            <div class="cm-ann-toolbar">
                <div class="cm-ann-tools">
                    <button class="cm-ann-tool active" data-tool="pen" title="Pen">&#9999;&#65039;</button>
                    <button class="cm-ann-tool" data-tool="arrow" title="Arrow">&#10148;</button>
                    <button class="cm-ann-tool" data-tool="rect" title="Rectangle">&#9634;</button>
                    <button class="cm-ann-tool" data-tool="text" title="Text">T</button>
                </div>
                <div class="cm-ann-colors">
                    ${COLORS.map(c => `<button class="cm-ann-color${c === color ? ' active' : ''}" data-color="${c}" style="background:${c}"></button>`).join('')}
                </div>
                <div class="cm-ann-actions">
                    <button class="cm-ann-undo" title="Undo">&#8617;</button>
                    <button class="cm-ann-cancel">Cancel</button>
                    <button class="cm-ann-done">Attach</button>
                </div>
            </div>
            <div class="cm-ann-canvas-wrap" style="width:${dispW}px;height:${dispH}px;">
                <canvas id="cm-ann-canvas" width="${cw}" height="${ch}" style="width:${dispW}px;height:${dispH}px;"></canvas>
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

        drawActions = [];
        tool = 'pen';
        isDrawing = false;

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

    function onDrawStart(e) {
        isDrawing = true;
        startPos = getCanvasPos(e);

        if (tool === 'pen') {
            // Start a new pen path
            const action = { type: 'pen', color, points: [startPos] };
            drawActions.push(action);
        } else if (tool === 'text') {
            isDrawing = false;
            const pos = startPos;
            const text = prompt('Enter text:');
            if (text) {
                drawActions.push({ type: 'text', color, pos, text });
                redraw();
            }
        }
    }

    function onDrawMove(e) {
        if (!isDrawing) return;
        const pos = getCanvasPos(e);

        if (tool === 'pen') {
            const action = drawActions[drawActions.length - 1];
            action.points.push(pos);
            redraw();
        } else if (tool === 'arrow' || tool === 'rect') {
            // Preview — redraw base + previous actions + current shape
            redraw();
            drawShape(tool, startPos, pos, color);
        }
    }

    function onDrawEnd(e) {
        if (!isDrawing) return;
        isDrawing = false;
        const pos = getCanvasPos(e);

        if (tool === 'arrow') {
            drawActions.push({ type: 'arrow', color, from: startPos, to: pos });
            redraw();
        } else if (tool === 'rect') {
            drawActions.push({ type: 'rect', color, from: startPos, to: pos });
            redraw();
        }
        startPos = null;
    }

    function redraw() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bgCanvas, 0, 0);

        for (const action of drawActions) {
            if (action.type === 'pen') {
                drawPen(action.points, action.color);
            } else if (action.type === 'arrow') {
                drawShape('arrow', action.from, action.to, action.color);
            } else if (action.type === 'rect') {
                drawShape('rect', action.from, action.to, action.color);
            } else if (action.type === 'text') {
                drawText(action.text, action.pos, action.color);
            }
        }
    }

    function drawPen(points, c) {
        if (points.length < 2) return;
        ctx.strokeStyle = c;
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
            ctx.lineTo(points[i].x, points[i].y);
        }
        ctx.stroke();
    }

    function drawShape(type, from, to, c) {
        ctx.strokeStyle = c;
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';

        if (type === 'rect') {
            ctx.strokeRect(from.x, from.y, to.x - from.x, to.y - from.y);
        } else if (type === 'arrow') {
            // Line
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

    function onToolbarClick(e) {
        const btn = e.target.closest('button');
        if (!btn) return;

        if (btn.dataset.tool) {
            tool = btn.dataset.tool;
            editorOverlay.querySelectorAll('.cm-ann-tool').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        } else if (btn.dataset.color) {
            color = btn.dataset.color;
            editorOverlay.querySelectorAll('.cm-ann-color').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        } else if (btn.classList.contains('cm-ann-undo')) {
            drawActions.pop();
            redraw();
        } else if (btn.classList.contains('cm-ann-cancel')) {
            closeEditor();
            if (onComplete) onComplete(null);
        } else if (btn.classList.contains('cm-ann-done')) {
            const dataUrl = canvas.toDataURL('image/png');
            closeEditor();
            if (onComplete) onComplete(dataUrl);
        }
    }

    function onEditorKey(e) {
        if (e.key === 'Escape') {
            closeEditor();
            if (onComplete) onComplete(null);
        } else if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
            drawActions.pop();
            redraw();
        }
    }

    function closeEditor() {
        if (editorOverlay) {
            editorOverlay.remove();
            editorOverlay = null;
        }
        canvas = null;
        ctx = null;
        bgCanvas = null;
        fullImage = null;
        document.removeEventListener('keydown', onEditorKey);
    }
})();
