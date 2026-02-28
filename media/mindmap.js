(function () {
  // @ts-check
  'use strict';

  /** @type {typeof acquireVsCodeApi} */
  const vscode = acquireVsCodeApi();

  // ─── Constants ───────────────────────────────────────────────
  const NODE_GAP_X = 60;
  const NODE_GAP_Y = 16;
  const NODE_PADDING_X = 16;
  const NODE_PADDING_Y = 8;
  const MIN_ZOOM = 0.2;
  const MAX_ZOOM = 3.0;
  const ZOOM_STEP = 0.1;
  const BRANCH_COLORS = [
    '#4fc3f7', '#81c784', '#ffb74d', '#e57373',
    '#ba68c8', '#4dd0e1', '#aed581', '#ff8a65',
  ];
  const IMAGE_THUMBNAIL_WIDTH = 120;
  const IMAGE_THUMBNAIL_HEIGHT = 80;
  const IMAGE_PADDING = 4;

  // ─── State ───────────────────────────────────────────────────
  let root = null;
  let selectedNodeId = null;
  let zoom = 1;
  let panX = 40;
  let panY = 0;
  let isPanning = false;
  let panStartX = 0;
  let panStartY = 0;
  let isDragging = false;
  let dragNodeId = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let dropTargetId = null;
  let dropPosition = null;   // 'before' | 'after' | 'child'
  let dragGhostEl = null;    // ドラッグゴーストHTML要素
  let isEditing = false;
  let suppressNextUpdate = false;
  let viewMode = 'split'; // 'split' | 'preview'
  let editorUpdateFromMindmap = false;
  let assetsBaseUri = '';
  const imageUriCache = {}; // relativePath -> webview URI

  // ─── DOM refs ────────────────────────────────────────────────
  const svg = document.getElementById('mindmap-svg');
  const container = document.getElementById('canvas-container');
  const nodeCountEl = document.getElementById('node-count');
  const mainContent = document.getElementById('main-content');
  const markdownPane = document.getElementById('markdown-pane');
  const markdownEditor = document.getElementById('markdown-editor');
  const divider = document.getElementById('divider');
  const btnSplit = document.getElementById('btn-split');
  const btnPreview = document.getElementById('btn-preview');

  // ─── View Mode ─────────────────────────────────────────────
  function setViewMode(mode) {
    viewMode = mode;
    mainContent.className = mode === 'split' ? 'mode-split' : 'mode-preview';
    btnSplit.classList.toggle('active', mode === 'split');
    btnPreview.classList.toggle('active', mode === 'preview');
    // Re-render to adjust layout after resize
    render();
  }

  // ─── Divider Resize ────────────────────────────────────────
  let isDividerDragging = false;

  divider.addEventListener('mousedown', (e) => {
    e.preventDefault();
    isDividerDragging = true;
    divider.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDividerDragging) return;
    const mainRect = mainContent.getBoundingClientRect();
    const newWidth = e.clientX - mainRect.left;
    const minWidth = 200;
    const maxWidth = mainRect.width - 200;
    if (newWidth >= minWidth && newWidth <= maxWidth) {
      markdownPane.style.width = newWidth + 'px';
    }
  });

  document.addEventListener('mouseup', () => {
    if (isDividerDragging) {
      isDividerDragging = false;
      divider.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });

  // ─── Markdown Editor Sync ──────────────────────────────────
  let editorDebounceTimer = null;

  markdownEditor.addEventListener('input', () => {
    if (editorUpdateFromMindmap) return;
    clearTimeout(editorDebounceTimer);
    editorDebounceTimer = setTimeout(() => {
      const text = markdownEditor.value;
      const newRoot = parseMarkdown(text);
      if (root) {
        preserveCollapsedState(root, newRoot);
      }
      root = newRoot;
      if (!selectedNodeId) {
        selectedNodeId = root.id;
      }
      render();
      // Save to document
      suppressNextUpdate = true;
      vscode.postMessage({ type: 'save', text: text });
    }, 300);
  });

  markdownEditor.addEventListener('keydown', (e) => {
    // Allow Tab for indentation in textarea
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = markdownEditor.selectionStart;
      const end = markdownEditor.selectionEnd;
      markdownEditor.value = markdownEditor.value.substring(0, start) + '  ' + markdownEditor.value.substring(end);
      markdownEditor.selectionStart = markdownEditor.selectionEnd = start + 2;
      markdownEditor.dispatchEvent(new Event('input'));
    }
  });

  function updateMarkdownEditor(text) {
    editorUpdateFromMindmap = true;
    const scrollTop = markdownEditor.scrollTop;
    const selStart = markdownEditor.selectionStart;
    const selEnd = markdownEditor.selectionEnd;
    markdownEditor.value = text;
    markdownEditor.scrollTop = scrollTop;
    // Restore cursor only if textarea is focused
    if (document.activeElement !== markdownEditor) {
      // Don't restore cursor if not focused
    } else {
      markdownEditor.selectionStart = Math.min(selStart, text.length);
      markdownEditor.selectionEnd = Math.min(selEnd, text.length);
    }
    editorUpdateFromMindmap = false;
  }

  // ─── Markdown Parser ─────────────────────────────────────────
  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
  }

  function parseMarkdown(text) {
    const lines = text.split('\n');
    let rootNode = null;
    const stack = []; // { node, indent }
    let lastNode = null; // 直前のリスト項目ノード（画像検出用）

    for (const line of lines) {
      // Root heading
      const headingMatch = line.match(/^#\s+(.+)/);
      if (headingMatch) {
        rootNode = { id: generateId(), text: headingMatch[1].trim(), children: [] };
        stack.length = 0;
        stack.push({ node: rootNode, indent: -1 });
        lastNode = null;
        continue;
      }

      // Image line (must follow a list item)
      const imageMatch = line.match(/^\s*!\[([^\]]*)\]\(([^)]+)\)/);
      if (imageMatch && lastNode) {
        lastNode.image = imageMatch[2];
        continue;
      }

      // List item
      const listMatch = line.match(/^(\s*)- (.+)/);
      if (listMatch && rootNode) {
        const indent = listMatch[1].length;
        const node = { id: generateId(), text: listMatch[2].trim(), children: [] };

        // Find parent: go back in stack until we find a node with smaller indent
        while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
          stack.pop();
        }

        const parent = stack[stack.length - 1].node;
        parent.children.push(node);
        stack.push({ node, indent });
        lastNode = node;
      } else {
        lastNode = null;
      }
    }

    return rootNode || { id: generateId(), text: 'Central Topic', children: [] };
  }

  // ─── Markdown Serializer ──────────────────────────────────────
  function serializeToMarkdown(node) {
    let result = `# ${node.text}\n`;

    function serializeChildren(children, depth) {
      for (const child of children) {
        const indent = '  '.repeat(depth);
        result += `${indent}- ${child.text}\n`;
        if (child.image) {
          result += `${indent}  ![](${child.image})\n`;
        }
        if (child.children.length > 0) {
          serializeChildren(child.children, depth + 1);
        }
      }
    }

    serializeChildren(node.children, 0);
    return result;
  }

  // ─── Layout Algorithm ─────────────────────────────────────────
  function measureTextWidth(text, fontSize) {
    // Approximate character width ratio
    return text.length * fontSize * 0.6 + NODE_PADDING_X * 2;
  }

  function getFontSize(depth) {
    if (depth === 0) return 16;
    if (depth === 1) return 14;
    return 13;
  }

  function getNodeHeight(depth, hasImage) {
    const textHeight = getFontSize(depth) + NODE_PADDING_Y * 2;
    if (hasImage) {
      return textHeight + IMAGE_THUMBNAIL_HEIGHT + IMAGE_PADDING;
    }
    return textHeight;
  }

  function layoutTree(node, depth, branchIndex) {
    const fontSize = getFontSize(depth);
    const hasImage = !!node.image;
    let width = Math.max(measureTextWidth(node.text, fontSize), 60);
    if (hasImage) {
      width = Math.max(width, IMAGE_THUMBNAIL_WIDTH + NODE_PADDING_X * 2);
    }
    const height = getNodeHeight(depth, hasImage);

    const layoutNode = {
      id: node.id,
      text: node.text,
      image: node.image || null,
      collapsed: node.collapsed || false,
      width,
      height,
      x: 0,
      y: 0,
      depth,
      branchIndex,
      children: [],
      hasChildren: node.children.length > 0,
    };

    if (!node.collapsed && node.children.length > 0) {
      layoutNode.children = node.children.map((child, i) => {
        const bi = depth === 0 ? i : branchIndex;
        return layoutTree(child, depth + 1, bi);
      });
    }

    return layoutNode;
  }

  function computeSubtreeHeight(layoutNode) {
    if (layoutNode.children.length === 0) {
      return layoutNode.height;
    }
    let totalHeight = 0;
    for (const child of layoutNode.children) {
      totalHeight += computeSubtreeHeight(child);
    }
    totalHeight += (layoutNode.children.length - 1) * NODE_GAP_Y;
    return Math.max(layoutNode.height, totalHeight);
  }

  function positionNodes(layoutNode, x, y) {
    const subtreeHeight = computeSubtreeHeight(layoutNode);
    layoutNode.x = x;
    layoutNode.y = y + subtreeHeight / 2 - layoutNode.height / 2;

    if (layoutNode.children.length > 0) {
      const childX = x + layoutNode.width + NODE_GAP_X;
      let childY = y;
      for (const child of layoutNode.children) {
        const childSubtreeHeight = computeSubtreeHeight(child);
        positionNodes(child, childX, childY);
        childY += childSubtreeHeight + NODE_GAP_Y;
      }
    }
  }

  // ─── Rendering ────────────────────────────────────────────────
  function flattenLayout(layoutNode, list) {
    list = list || [];
    list.push(layoutNode);
    for (const child of layoutNode.children) {
      flattenLayout(child, list);
    }
    return list;
  }

  function render() {
    if (!root) return;

    const layoutRoot = layoutTree(root, 0, 0);
    positionNodes(layoutRoot, 0, 0);
    const allNodes = flattenLayout(layoutRoot);

    // Update node count
    const totalCount = countNodes(root);
    nodeCountEl.textContent = `${totalCount} nodes`;

    // Clear SVG
    while (svg.firstChild) {
      svg.removeChild(svg.firstChild);
    }

    // Create main group for pan & zoom
    const g = createSvgElement('g');
    g.setAttribute('transform', `translate(${panX},${panY}) scale(${zoom})`);
    svg.appendChild(g);

    // Draw connections first (below nodes)
    for (const node of allNodes) {
      for (const child of node.children) {
        drawConnection(g, node, child);
      }
    }

    // Draw nodes
    for (const node of allNodes) {
      drawNode(g, node);
    }

    // Draw drop indicator for before/after
    if (isDragging && dropTargetId && (dropPosition === 'before' || dropPosition === 'after')) {
      const targetLayoutNode = allNodes.find(n => n.id === dropTargetId);
      if (targetLayoutNode) {
        const indicatorY = dropPosition === 'before'
          ? targetLayoutNode.y - NODE_GAP_Y / 2
          : targetLayoutNode.y + targetLayoutNode.height + NODE_GAP_Y / 2;
        const x1 = targetLayoutNode.x;
        const x2 = targetLayoutNode.x + targetLayoutNode.width;

        const line = createSvgElement('line');
        line.setAttribute('x1', String(x1));
        line.setAttribute('y1', String(indicatorY));
        line.setAttribute('x2', String(x2));
        line.setAttribute('y2', String(indicatorY));
        line.setAttribute('class', 'mm-drop-indicator-line');
        g.appendChild(line);

        const dot = createSvgElement('circle');
        dot.setAttribute('cx', String(x1));
        dot.setAttribute('cy', String(indicatorY));
        dot.setAttribute('r', '4');
        dot.setAttribute('class', 'mm-drop-indicator-dot');
        g.appendChild(dot);
      }
    }
  }

  function drawConnection(parent, fromNode, toNode) {
    const x1 = fromNode.x + fromNode.width;
    const y1 = fromNode.y + fromNode.height / 2;
    const x2 = toNode.x;
    const y2 = toNode.y + toNode.height / 2;

    const cpx = (x1 + x2) / 2;

    const path = createSvgElement('path');
    path.setAttribute('d', `M${x1},${y1} C${cpx},${y1} ${cpx},${y2} ${x2},${y2}`);
    path.setAttribute('class', 'mm-connection');
    path.setAttribute('stroke', getBranchColor(toNode.branchIndex));
    parent.appendChild(path);
  }

  function drawNode(parent, node) {
    const group = createSvgElement('g');
    group.setAttribute('class', `mm-node depth-${Math.min(node.depth, 2)}${node.id === selectedNodeId ? ' selected' : ''}`);
    group.setAttribute('data-id', node.id);
    group.setAttribute('transform', `translate(${node.x},${node.y})`);

    const color = getBranchColor(node.depth === 0 ? 0 : node.branchIndex);
    const opacity = Math.max(0.4, 1 - node.depth * 0.15);

    // Rectangle
    const rect = createSvgElement('rect');
    rect.setAttribute('width', String(node.width));
    rect.setAttribute('height', String(node.height));
    rect.setAttribute('fill', node.depth === 0 ? color : adjustColor(color, 0.2));
    rect.setAttribute('stroke', color);
    rect.setAttribute('opacity', String(opacity));
    group.appendChild(rect);

    // Text
    const text = createSvgElement('text');
    text.setAttribute('x', String(node.width / 2));
    text.setAttribute('y', String(node.height / 2));
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'central');
    text.setAttribute('font-size', String(getFontSize(node.depth)));
    text.setAttribute('fill', node.depth === 0 ? '#1e1e1e' : 'var(--vscode-editor-foreground, #cccccc)');
    text.textContent = node.text;
    group.appendChild(text);

    // Collapse indicator
    if (node.hasChildren) {
      const collapsed = node.collapsed;
      const indicatorGroup = createSvgElement('g');
      indicatorGroup.setAttribute('class', 'mm-collapse-indicator');
      indicatorGroup.setAttribute('transform', `translate(${node.width - 2},${node.height / 2})`);

      const circle = createSvgElement('circle');
      circle.setAttribute('r', '8');
      circle.setAttribute('fill', 'var(--vscode-editor-background, #1e1e1e)');
      circle.setAttribute('stroke', color);
      circle.setAttribute('stroke-width', '1.5');
      indicatorGroup.appendChild(circle);

      const indicatorText = createSvgElement('text');
      indicatorText.setAttribute('text-anchor', 'middle');
      indicatorText.setAttribute('dominant-baseline', 'central');
      indicatorText.setAttribute('font-size', '11');
      indicatorText.setAttribute('fill', color);
      indicatorText.textContent = collapsed ? '+' : '−';
      indicatorGroup.appendChild(indicatorText);

      indicatorGroup.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleCollapse(node.id);
      });

      group.appendChild(indicatorGroup);
    }

    // Image thumbnail
    if (node.image) {
      const textHeight = getFontSize(node.depth) + NODE_PADDING_Y * 2;
      const imgX = (node.width - IMAGE_THUMBNAIL_WIDTH) / 2;
      const imgY = textHeight + IMAGE_PADDING / 2;
      const cachedUri = imageUriCache[node.image];
      if (cachedUri) {
        const img = createSvgElement('image');
        img.setAttribute('href', cachedUri);
        img.setAttribute('x', String(imgX));
        img.setAttribute('y', String(imgY));
        img.setAttribute('width', String(IMAGE_THUMBNAIL_WIDTH));
        img.setAttribute('height', String(IMAGE_THUMBNAIL_HEIGHT));
        img.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        img.setAttribute('class', 'mm-node-image');
        group.appendChild(img);
      } else {
        // Placeholder
        const placeholder = createSvgElement('rect');
        placeholder.setAttribute('x', String(imgX));
        placeholder.setAttribute('y', String(imgY));
        placeholder.setAttribute('width', String(IMAGE_THUMBNAIL_WIDTH));
        placeholder.setAttribute('height', String(IMAGE_THUMBNAIL_HEIGHT));
        placeholder.setAttribute('class', 'mm-image-placeholder');
        placeholder.setAttribute('rx', '4');
        group.appendChild(placeholder);
        const placeholderText = createSvgElement('text');
        placeholderText.setAttribute('x', String(node.width / 2));
        placeholderText.setAttribute('y', String(imgY + IMAGE_THUMBNAIL_HEIGHT / 2));
        placeholderText.setAttribute('text-anchor', 'middle');
        placeholderText.setAttribute('dominant-baseline', 'central');
        placeholderText.setAttribute('font-size', '10');
        placeholderText.setAttribute('fill', 'var(--vscode-descriptionForeground, #888)');
        placeholderText.textContent = 'Loading...';
        group.appendChild(placeholderText);
        requestImageUri(node.image);
      }
    }

    // Drop target highlight (only for 'child' mode)
    if (node.id === dropTargetId && dropPosition === 'child') {
      group.classList.add('mm-drop-target');
    }

    // Event listeners
    group.addEventListener('mousedown', (e) => onNodeMouseDown(e, node));
    group.addEventListener('click', (e) => {
      e.stopPropagation();
      selectNode(node.id);
    });

    parent.appendChild(group);
  }

  function getBranchColor(index) {
    return BRANCH_COLORS[index % BRANCH_COLORS.length];
  }

  function adjustColor(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function createSvgElement(tag) {
    return document.createElementNS('http://www.w3.org/2000/svg', tag);
  }

  function countNodes(node) {
    let count = 1;
    for (const child of node.children) {
      count += countNodes(child);
    }
    return count;
  }

  // ─── Node Operations ─────────────────────────────────────────
  function findNode(node, id) {
    if (node.id === id) return node;
    for (const child of node.children) {
      const found = findNode(child, id);
      if (found) return found;
    }
    return null;
  }

  function findParent(node, id) {
    for (const child of node.children) {
      if (child.id === id) return node;
      const found = findParent(child, id);
      if (found) return found;
    }
    return null;
  }

  function selectNode(id) {
    const prev = selectedNodeId;
    selectedNodeId = id;
    // Update visual selection without full re-render to preserve DOM for dblclick
    if (prev) {
      const prevEl = svg.querySelector(`g.mm-node[data-id="${prev}"]`);
      if (prevEl) prevEl.classList.remove('selected');
    }
    const newEl = svg.querySelector(`g.mm-node[data-id="${id}"]`);
    if (newEl) newEl.classList.add('selected');
  }

  function addChild() {
    if (!selectedNodeId || !root) return;
    const parent = findNode(root, selectedNodeId);
    if (!parent) return;
    parent.collapsed = false;
    const newNode = { id: generateId(), text: 'New Topic', children: [] };
    parent.children.push(newNode);
    selectedNodeId = newNode.id;
    saveAndRender();
    startEditing({ id: newNode.id, text: newNode.text });
  }

  function addSibling() {
    if (!selectedNodeId || !root) return;
    if (selectedNodeId === root.id) return; // Can't add sibling to root
    const parent = findParent(root, selectedNodeId);
    if (!parent) return;
    const index = parent.children.findIndex((c) => c.id === selectedNodeId);
    const newNode = { id: generateId(), text: 'New Topic', children: [] };
    parent.children.splice(index + 1, 0, newNode);
    selectedNodeId = newNode.id;
    saveAndRender();
    startEditing({ id: newNode.id, text: newNode.text });
  }

  function deleteNode() {
    if (!selectedNodeId || !root) return;
    if (selectedNodeId === root.id) return; // Can't delete root
    const parent = findParent(root, selectedNodeId);
    if (!parent) return;
    const index = parent.children.findIndex((c) => c.id === selectedNodeId);
    if (index === -1) return;
    parent.children.splice(index, 1);

    // Select next logical node
    if (parent.children.length > 0) {
      const nextIndex = Math.min(index, parent.children.length - 1);
      selectedNodeId = parent.children[nextIndex].id;
    } else {
      selectedNodeId = parent.id;
    }
    saveAndRender();
  }

  function toggleCollapse(id) {
    if (!root) return;
    const node = findNode(root, id || selectedNodeId);
    if (!node || node.children.length === 0) return;
    node.collapsed = !node.collapsed;
    render();
  }

  // ─── Navigation ───────────────────────────────────────────────
  function navigateUp() {
    if (!selectedNodeId || !root) return;
    if (selectedNodeId === root.id) return;
    const parent = findParent(root, selectedNodeId);
    if (!parent) return;
    const index = parent.children.findIndex((c) => c.id === selectedNodeId);
    if (index > 0) {
      selectedNodeId = parent.children[index - 1].id;
    }
    render();
  }

  function navigateDown() {
    if (!selectedNodeId || !root) return;
    if (selectedNodeId === root.id) return;
    const parent = findParent(root, selectedNodeId);
    if (!parent) return;
    const index = parent.children.findIndex((c) => c.id === selectedNodeId);
    if (index < parent.children.length - 1) {
      selectedNodeId = parent.children[index + 1].id;
    }
    render();
  }

  function navigateLeft() {
    if (!selectedNodeId || !root) return;
    if (selectedNodeId === root.id) return;
    const parent = findParent(root, selectedNodeId);
    if (parent) {
      selectedNodeId = parent.id;
      render();
    }
  }

  function navigateRight() {
    if (!selectedNodeId || !root) return;
    const node = findNode(root, selectedNodeId);
    if (node && node.children.length > 0 && !node.collapsed) {
      selectedNodeId = node.children[0].id;
      render();
    }
  }

  // ─── Inline Editing ───────────────────────────────────────────
  function startEditing(layoutNode) {
    if (isEditing) return;
    isEditing = true;

    const node = findNode(root, layoutNode.id);
    if (!node) { isEditing = false; return; }

    selectNode(node.id);

    // Find the node's SVG element to position the input
    const svgNode = svg.querySelector(`g[data-id="${node.id}"]`);
    if (!svgNode) { isEditing = false; return; }

    // Hide SVG text to prevent see-through while editing
    const svgText = svgNode.querySelector('text');
    if (svgText) {
      svgText.style.visibility = 'hidden';
    }

    const rect = svgNode.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();

    const input = document.createElement('input');
    input.className = 'mm-inline-editor';
    input.value = node.text;
    input.style.left = `${rect.left - containerRect.left}px`;
    input.style.top = `${rect.top - containerRect.top}px`;
    input.style.width = `${Math.max(rect.width, 100)}px`;
    input.style.height = `${rect.height}px`;

    container.appendChild(input);
    input.focus();
    input.select();

    const restoreSvgText = () => {
      if (svgText) {
        svgText.style.visibility = '';
      }
    };

    const finishEditing = () => {
      if (!isEditing) return;
      isEditing = false;
      restoreSvgText();
      const newText = input.value.trim();
      if (newText && newText !== node.text) {
        node.text = newText;
        saveAndRender();
      } else {
        render();
      }
      if (input.parentNode) {
        input.parentNode.removeChild(input);
      }
    };

    input.addEventListener('blur', finishEditing);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finishEditing();
      } else if (e.key === 'Escape') {
        isEditing = false;
        restoreSvgText();
        if (input.parentNode) {
          input.parentNode.removeChild(input);
        }
        render();
      }
    });
  }

  // ─── Drag & Drop ──────────────────────────────────────────────
  function isDescendant(ancestorId, nodeId) {
    if (!root) return false;
    const ancestor = findNode(root, ancestorId);
    if (!ancestor) return false;
    function check(node) {
      if (node.id === nodeId) return true;
      for (const child of node.children) {
        if (check(child)) return true;
      }
      return false;
    }
    return check(ancestor);
  }

  function onNodeMouseDown(e, node) {
    if (e.button !== 0 || isEditing) return;
    if (node.id === root.id) return; // Can't drag root

    dragNodeId = node.id;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    isDragging = false;
  }

  function onMouseMove(e) {
    if (dragNodeId) {
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      if (!isDragging && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
        isDragging = true;
        const dragNode = findNode(root, dragNodeId);
        if (dragNode) {
          createDragGhost(dragNode.text, e.clientX, e.clientY);
        }
      }
      if (isDragging) {
        updateDragGhost(e.clientX, e.clientY);

        // Find node under cursor
        const target = findNodeAtPoint(e.clientX, e.clientY);
        if (target && target !== dragNodeId && !isDescendant(dragNodeId, target)) {
          dropTargetId = target;

          // Determine drop position based on cursor Y within target node
          const targetEl = svg.querySelector(`g.mm-node[data-id="${target}"]`);
          const targetDataNode = findNode(root, target);
          if (targetEl && targetDataNode) {
            // Root node always gets 'child'
            if (target === root.id) {
              dropPosition = 'child';
            } else {
              const rect = targetEl.getBoundingClientRect();
              const relY = (e.clientY - rect.top) / rect.height;
              if (relY < 0.3) {
                dropPosition = 'before';
              } else if (relY > 0.7) {
                dropPosition = 'after';
              } else {
                dropPosition = 'child';
              }
            }
          }
        } else {
          dropTargetId = null;
          dropPosition = null;
        }
        render();
      }
    }

    if (isPanning) {
      panX += e.clientX - panStartX;
      panY += e.clientY - panStartY;
      panStartX = e.clientX;
      panStartY = e.clientY;
      render();
    }
  }

  function onMouseUp() {
    if (isDragging && dragNodeId && dropTargetId && dropPosition && root) {
      const parent = findParent(root, dragNodeId);
      if (parent) {
        const index = parent.children.findIndex((c) => c.id === dragNodeId);
        const [movedNode] = parent.children.splice(index, 1);

        if (dropPosition === 'child') {
          // Add as child of target
          const targetNode = findNode(root, dropTargetId);
          if (targetNode) {
            targetNode.children.push(movedNode);
            targetNode.collapsed = false;
          }
        } else {
          // Insert before or after target as sibling
          const targetParent = findParent(root, dropTargetId);
          const insertParent = targetParent || root; // fallback to root
          const targetIndex = insertParent.children.findIndex((c) => c.id === dropTargetId);
          if (targetIndex !== -1) {
            const insertIndex = dropPosition === 'before' ? targetIndex : targetIndex + 1;
            insertParent.children.splice(insertIndex, 0, movedNode);
          } else {
            // Fallback: add as child
            insertParent.children.push(movedNode);
          }
        }

        selectedNodeId = movedNode.id;
        saveAndRender();
      }
    }

    removeDragGhost();
    dragNodeId = null;
    isDragging = false;
    dropTargetId = null;
    dropPosition = null;
    isPanning = false;
    container.classList.remove('panning');
  }

  // ─── Drag Ghost ──────────────────────────────────────────────
  function createDragGhost(text, clientX, clientY) {
    removeDragGhost();
    dragGhostEl = document.createElement('div');
    dragGhostEl.className = 'mm-drag-ghost-overlay';
    dragGhostEl.textContent = text;
    dragGhostEl.style.left = `${clientX}px`;
    dragGhostEl.style.top = `${clientY}px`;
    document.body.appendChild(dragGhostEl);
  }

  function updateDragGhost(clientX, clientY) {
    if (dragGhostEl) {
      dragGhostEl.style.left = `${clientX}px`;
      dragGhostEl.style.top = `${clientY}px`;
    }
  }

  function removeDragGhost() {
    if (dragGhostEl) {
      dragGhostEl.remove();
      dragGhostEl = null;
    }
  }

  function findNodeAtPoint(clientX, clientY) {
    const elements = document.elementsFromPoint(clientX, clientY);
    for (const el of elements) {
      const nodeGroup = el.closest('.mm-node');
      if (nodeGroup) {
        return nodeGroup.getAttribute('data-id');
      }
    }
    return null;
  }

  // ─── Pan & Zoom ───────────────────────────────────────────────
  function onWheel(e) {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom + delta));

    // Zoom toward mouse position
    const containerRect = container.getBoundingClientRect();
    const mouseX = e.clientX - containerRect.left;
    const mouseY = e.clientY - containerRect.top;

    const scale = newZoom / zoom;
    panX = mouseX - (mouseX - panX) * scale;
    panY = mouseY - (mouseY - panY) * scale;

    zoom = newZoom;
    render();
  }

  function onContainerMouseDown(e) {
    if (e.target === svg || e.target === container) {
      isPanning = true;
      panStartX = e.clientX;
      panStartY = e.clientY;
      container.classList.add('panning');

      // Deselect node when clicking background
      selectedNodeId = null;
      render();
    }
  }

  function zoomIn() {
    zoom = Math.min(MAX_ZOOM, zoom + ZOOM_STEP);
    render();
  }

  function zoomOut() {
    zoom = Math.max(MIN_ZOOM, zoom - ZOOM_STEP);
    render();
  }

  function fitToScreen() {
    if (!root) return;

    const layoutRoot = layoutTree(root, 0, 0);
    positionNodes(layoutRoot, 0, 0);
    const allNodes = flattenLayout(layoutRoot);

    if (allNodes.length === 0) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of allNodes) {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + node.width);
      maxY = Math.max(maxY, node.y + node.height);
    }

    const contentWidth = maxX - minX;
    const contentHeight = maxY - minY;
    const containerRect = container.getBoundingClientRect();
    const padding = 40;

    const scaleX = (containerRect.width - padding * 2) / contentWidth;
    const scaleY = (containerRect.height - padding * 2) / contentHeight;
    zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(scaleX, scaleY)));

    panX = padding - minX * zoom + (containerRect.width - padding * 2 - contentWidth * zoom) / 2;
    panY = padding - minY * zoom + (containerRect.height - padding * 2 - contentHeight * zoom) / 2;

    render();
  }

  // ─── Export ───────────────────────────────────────────────────
  function exportSvg() {
    const svgClone = svg.cloneNode(true);
    svgClone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

    // Set viewBox based on content
    if (root) {
      const layoutRoot = layoutTree(root, 0, 0);
      positionNodes(layoutRoot, 0, 0);
      const allNodes = flattenLayout(layoutRoot);

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const node of allNodes) {
        minX = Math.min(minX, node.x);
        minY = Math.min(minY, node.y);
        maxX = Math.max(maxX, node.x + node.width);
        maxY = Math.max(maxY, node.y + node.height);
      }

      const padding = 20;
      svgClone.setAttribute('viewBox', `${minX - padding} ${minY - padding} ${maxX - minX + padding * 2} ${maxY - minY + padding * 2}`);
      svgClone.setAttribute('width', String(maxX - minX + padding * 2));
      svgClone.setAttribute('height', String(maxY - minY + padding * 2));

      // Reset the transform to fit content without pan/zoom
      const mainGroup = svgClone.querySelector('g');
      if (mainGroup) {
        mainGroup.setAttribute('transform', '');
      }
    }

    const serializer = new XMLSerializer();
    const svgString = serializer.serializeToString(svgClone);
    vscode.postMessage({ type: 'saveSvg', svg: svgString });
  }

  function exportMarkdown() {
    if (!root) return;
    const md = serializeToMarkdown(root);
    vscode.postMessage({ type: 'saveMarkdown', markdown: md });
  }

  // ─── Save & Render ────────────────────────────────────────────
  function saveAndRender() {
    if (!root) return;
    suppressNextUpdate = true;
    const markdown = serializeToMarkdown(root);
    vscode.postMessage({ type: 'save', text: markdown });
    updateMarkdownEditor(markdown);
    render();
  }

  // ─── Event Handlers ───────────────────────────────────────────
  // Toolbar buttons
  document.getElementById('btn-add-child').addEventListener('click', addChild);
  document.getElementById('btn-add-sibling').addEventListener('click', addSibling);
  document.getElementById('btn-delete').addEventListener('click', deleteNode);
  document.getElementById('btn-collapse').addEventListener('click', () => toggleCollapse());
  document.getElementById('btn-zoom-in').addEventListener('click', zoomIn);
  document.getElementById('btn-zoom-out').addEventListener('click', zoomOut);
  document.getElementById('btn-fit').addEventListener('click', fitToScreen);
  document.getElementById('btn-export-svg').addEventListener('click', exportSvg);
  document.getElementById('btn-export-md').addEventListener('click', exportMarkdown);

  // View mode toggle
  btnSplit.addEventListener('click', () => setViewMode('split'));
  btnPreview.addEventListener('click', () => setViewMode('preview'));

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Don't intercept keys when editing markdown textarea
    if (isEditing || document.activeElement === markdownEditor) return;

    switch (e.key) {
      case 'Tab':
        e.preventDefault();
        addChild();
        break;
      case 'Enter':
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          addSibling();
        }
        break;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        deleteNode();
        break;
      case ' ':
        e.preventDefault();
        toggleCollapse();
        break;
      case 'F2':
        e.preventDefault();
        if (selectedNodeId) {
          startEditing({ id: selectedNodeId });
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        navigateUp();
        break;
      case 'ArrowDown':
        e.preventDefault();
        navigateDown();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        navigateLeft();
        break;
      case 'ArrowRight':
        e.preventDefault();
        navigateRight();
        break;
      case '+':
      case '=':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          zoomIn();
        }
        break;
      case '-':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          zoomOut();
        }
        break;
      case '0':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          fitToScreen();
        }
        break;
    }
  });

  // Mouse events
  container.addEventListener('mousedown', onContainerMouseDown);
  container.addEventListener('dblclick', (e) => {
    const nodeId = findNodeAtPoint(e.clientX, e.clientY);
    if (nodeId) {
      e.stopPropagation();
      startEditing({ id: nodeId });
    }
  });
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
  container.addEventListener('wheel', onWheel, { passive: false });

  // ─── Image Paste ────────────────────────────────────────────────
  function requestImageUri(relativePath) {
    if (imageUriCache[relativePath]) return;
    vscode.postMessage({ type: 'getImageUri', relativePath });
  }

  document.addEventListener('paste', (e) => {
    // Skip if editing markdown or inline editing
    if (isEditing || document.activeElement === markdownEditor) return;
    // Skip if no node selected
    if (!selectedNodeId || !root) return;

    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) return;

        const ext = item.type.split('/')[1] || 'png';
        const fileName = `${Date.now()}-${Math.random().toString(36).substr(2, 6)}.${ext}`;

        const reader = new FileReader();
        reader.onload = () => {
          vscode.postMessage({
            type: 'saveImage',
            nodeId: selectedNodeId,
            base64: reader.result,
            fileName,
          });
        };
        reader.readAsDataURL(file);
        return; // 1回のペーストで1画像のみ
      }
    }
  });

  // ─── Context Menu ──────────────────────────────────────────────
  const contextMenu = document.getElementById('context-menu');

  function showContextMenu(x, y, hasNode) {
    const items = contextMenu.querySelectorAll('.context-menu-item');
    items.forEach((item) => {
      const action = item.getAttribute('data-action');
      if (['edit', 'add-child', 'add-sibling', 'collapse', 'delete'].includes(action)) {
        item.classList.toggle('disabled', !hasNode);
      }
    });

    contextMenu.style.display = 'block';
    contextMenu.style.left = `${x}px`;
    contextMenu.style.top = `${y}px`;

    // Adjust if menu goes off-screen
    const menuRect = contextMenu.getBoundingClientRect();
    if (menuRect.right > window.innerWidth) {
      contextMenu.style.left = `${x - menuRect.width}px`;
    }
    if (menuRect.bottom > window.innerHeight) {
      contextMenu.style.top = `${y - menuRect.height}px`;
    }
  }

  function hideContextMenu() {
    contextMenu.style.display = 'none';
  }

  container.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    hideContextMenu();

    const nodeId = findNodeAtPoint(e.clientX, e.clientY);
    if (nodeId) {
      selectNode(nodeId);
    }

    showContextMenu(e.clientX, e.clientY, !!nodeId);
  });

  contextMenu.addEventListener('click', (e) => {
    const item = e.target.closest('.context-menu-item');
    if (!item || item.classList.contains('disabled')) return;

    const action = item.getAttribute('data-action');
    hideContextMenu();

    switch (action) {
      case 'edit':
        if (selectedNodeId) startEditing({ id: selectedNodeId });
        break;
      case 'add-child':
        addChild();
        break;
      case 'add-sibling':
        addSibling();
        break;
      case 'collapse':
        toggleCollapse();
        break;
      case 'delete':
        deleteNode();
        break;
    }
  });

  document.addEventListener('click', (e) => {
    if (!contextMenu.contains(e.target)) {
      hideContextMenu();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && contextMenu.style.display !== 'none') {
      hideContextMenu();
    }
  }, true);

  // ─── VS Code Messaging ────────────────────────────────────────
  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'update': {
        if (suppressNextUpdate) {
          suppressNextUpdate = false;
          return;
        }
        const newRoot = parseMarkdown(message.text);
        // Preserve collapsed state from old tree
        if (root) {
          preserveCollapsedState(root, newRoot);
        }
        root = newRoot;
        if (!selectedNodeId) {
          selectedNodeId = root.id;
        }
        updateMarkdownEditor(message.text);
        render();
        break;
      }
      case 'exportSvg':
        exportSvg();
        break;
      case 'exportMarkdown':
        exportMarkdown();
        break;
      case 'setDocumentInfo':
        assetsBaseUri = message.assetsBaseUri || '';
        break;
      case 'imageReady': {
        // Image saved: update node data and URI cache
        const node = findNode(root, message.nodeId);
        if (node) {
          node.image = message.relativePath;
        }
        imageUriCache[message.relativePath] = message.webviewUri;
        saveAndRender();
        break;
      }
      case 'imageUriResolved':
        imageUriCache[message.relativePath] = message.webviewUri;
        render();
        break;
    }
  });

  function preserveCollapsedState(oldNode, newNode) {
    // Match by position in tree since IDs are regenerated on parse
    newNode.collapsed = oldNode.collapsed || false;
    if (oldNode.image) {
      newNode.image = oldNode.image;
    }
    const minLen = Math.min(oldNode.children.length, newNode.children.length);
    for (let i = 0; i < minLen; i++) {
      preserveCollapsedState(oldNode.children[i], newNode.children[i]);
    }
  }
})();
