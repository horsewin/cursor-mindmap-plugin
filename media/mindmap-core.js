// mindmap-core.js — Pure logic functions for mindmap parsing, serialization, and layout.
// This module is shared between the webview (browser) and Node.js tests (UMD pattern).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MindmapCore = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ─── Constants ───────────────────────────────────────────────
  const NODE_GAP_X = 60;
  const NODE_GAP_Y = 16;
  const NODE_PADDING_X = 16;
  const NODE_PADDING_Y = 8;
  const IMAGE_THUMBNAIL_WIDTH = 120;
  const IMAGE_THUMBNAIL_HEIGHT = 80;
  const IMAGE_PADDING = 4;
  const MAX_NODE_WIDTH = 300;
  const LINE_HEIGHT_RATIO = 1.4;

  // ─── Helpers ────────────────────────────────────────────────
  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
  }

  // ─── Markdown Parser ────────────────────────────────────────
  function parseMarkdown(text) {
    const lines = text.split('\n');
    let rootNode = null;
    const stack = []; // { node, indent, headingLevel }
    let lastNode = null;

    for (const line of lines) {
      // Heading (H1-H4)
      const headingMatch = line.match(/^(#{1,4})\s+(.+)/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        const nodeText = headingMatch[2].trim();

        if (level === 1) {
          rootNode = { id: generateId(), text: nodeText, children: [], headingLevel: 1 };
          stack.length = 0;
          stack.push({ node: rootNode, indent: -1, headingLevel: 1 });
          lastNode = null;
        } else if (rootNode) {
          const node = { id: generateId(), text: nodeText, children: [], headingLevel: level };

          // Pop stack until we find a heading with level < current
          while (stack.length > 1) {
            const top = stack[stack.length - 1];
            if (top.headingLevel > 0 && top.headingLevel < level) break;
            stack.pop();
          }

          const parent = stack[stack.length - 1].node;
          parent.children.push(node);
          stack.push({ node, indent: -1, headingLevel: level });
          lastNode = node;
        }
        continue;
      }

      // Image line (must follow a list item or heading)
      const imageMatch = line.match(/^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s*=(\d+)x(\d+))?\)/);
      if (imageMatch && lastNode) {
        lastNode.image = imageMatch[2];
        if (imageMatch[3]) {
          lastNode.imageWidth = parseInt(imageMatch[3]);
        }
        if (imageMatch[4]) {
          lastNode.imageHeight = parseInt(imageMatch[4]);
        }
        continue;
      }

      // List item
      const listMatch = line.match(/^(\s*)- (.+)/);
      if (listMatch && rootNode) {
        const indent = listMatch[1].length;
        const node = { id: generateId(), text: listMatch[2].trim(), children: [] };

        while (stack.length > 1) {
          const top = stack[stack.length - 1];
          if (top.headingLevel > 0) break;
          if (top.indent < indent) break;
          stack.pop();
        }

        const parent = stack[stack.length - 1].node;
        parent.children.push(node);
        stack.push({ node, indent, headingLevel: 0 });
        lastNode = node;
      } else {
        lastNode = null;
      }
    }

    return rootNode || { id: generateId(), text: 'Central Topic', children: [] };
  }

  // ─── Markdown Serializer ────────────────────────────────────
  function serializeToMarkdown(node) {
    let result = `# ${node.text}\n`;

    function serializeChildren(children, depth) {
      for (const child of children) {
        if (child.headingLevel >= 2) {
          const hashes = '#'.repeat(child.headingLevel);
          result += `${hashes} ${child.text}\n`;
          if (child.image) {
            const sizeStr = (child.imageWidth && child.imageHeight) ? ` =${child.imageWidth}x${child.imageHeight}` : '';
            result += `![](${child.image}${sizeStr})\n`;
          }
          if (child.children.length > 0) {
            serializeChildren(child.children, 0);
          }
        } else {
          const indent = '  '.repeat(depth);
          result += `${indent}- ${child.text}\n`;
          if (child.image) {
            const sizeStr = (child.imageWidth && child.imageHeight) ? ` =${child.imageWidth}x${child.imageHeight}` : '';
            result += `${indent}  ![](${child.image}${sizeStr})\n`;
          }
          if (child.children.length > 0) {
            serializeChildren(child.children, depth + 1);
          }
        }
      }
    }

    serializeChildren(node.children, 0);
    return result;
  }

  // ─── Layout Utilities ───────────────────────────────────────
  function measureTextWidth(text, fontSize) {
    return text.length * fontSize * 0.6 + NODE_PADDING_X * 2;
  }

  function wrapText(text, fontSize, maxWidth) {
    const charWidth = fontSize * 0.6;
    const availableWidth = maxWidth - NODE_PADDING_X * 2;
    const charsPerLine = Math.max(1, Math.floor(availableWidth / charWidth));
    const lines = [];
    let remaining = text;
    while (remaining.length > charsPerLine) {
      lines.push(remaining.substring(0, charsPerLine));
      remaining = remaining.substring(charsPerLine);
    }
    if (remaining.length > 0) {
      lines.push(remaining);
    }
    return lines;
  }

  function getFontSize(depth) {
    if (depth === 0) return 16;
    if (depth === 1) return 14;
    return 13;
  }

  function getNodeHeight(depth, imgHeight) {
    const textHeight = getFontSize(depth) + NODE_PADDING_Y * 2;
    if (imgHeight > 0) {
      return textHeight + imgHeight + IMAGE_PADDING;
    }
    return textHeight;
  }

  function layoutTree(node, depth, branchIndex) {
    const fontSize = getFontSize(depth);
    const lineHeight = fontSize * LINE_HEIGHT_RATIO;
    const hasImage = !!node.image;
    const imgW = node.imageWidth || IMAGE_THUMBNAIL_WIDTH;
    const imgH = node.imageHeight || IMAGE_THUMBNAIL_HEIGHT;
    let rawWidth = Math.max(measureTextWidth(node.text, fontSize), 60);
    let width = Math.min(rawWidth, MAX_NODE_WIDTH);
    if (hasImage) {
      width = Math.max(width, imgW + NODE_PADDING_X * 2);
    }
    const textLines = rawWidth > MAX_NODE_WIDTH
      ? wrapText(node.text, fontSize, MAX_NODE_WIDTH)
      : [node.text];
    const textBlockHeight = textLines.length * lineHeight + NODE_PADDING_Y * 2;
    let height = textBlockHeight;
    if (hasImage) {
      height += imgH + IMAGE_PADDING;
    }

    const layoutNode = {
      id: node.id,
      text: node.text,
      image: node.image || null,
      imageWidth: node.imageWidth || null,
      imageHeight: node.imageHeight || null,
      collapsed: node.collapsed || false,
      headingLevel: node.headingLevel || 0,
      textLines,
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

  function preserveCollapsedState(oldNode, newNode) {
    newNode.collapsed = oldNode.collapsed || false;
    if (oldNode.headingLevel) {
      newNode.headingLevel = oldNode.headingLevel;
    }
    if (oldNode.image) {
      newNode.image = oldNode.image;
    }
    if (oldNode.imageWidth) {
      newNode.imageWidth = oldNode.imageWidth;
    }
    if (oldNode.imageHeight) {
      newNode.imageHeight = oldNode.imageHeight;
    }
    const minLen = Math.min(oldNode.children.length, newNode.children.length);
    for (let i = 0; i < minLen; i++) {
      preserveCollapsedState(oldNode.children[i], newNode.children[i]);
    }
  }

  // ─── Public API ─────────────────────────────────────────────
  return {
    // Constants
    NODE_GAP_X,
    NODE_GAP_Y,
    NODE_PADDING_X,
    NODE_PADDING_Y,
    IMAGE_THUMBNAIL_WIDTH,
    IMAGE_THUMBNAIL_HEIGHT,
    IMAGE_PADDING,
    MAX_NODE_WIDTH,
    LINE_HEIGHT_RATIO,
    // Functions
    generateId,
    parseMarkdown,
    serializeToMarkdown,
    measureTextWidth,
    wrapText,
    getFontSize,
    getNodeHeight,
    layoutTree,
    computeSubtreeHeight,
    positionNodes,
    preserveCollapsedState,
  };
});
