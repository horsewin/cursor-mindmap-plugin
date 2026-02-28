import { describe, it, expect } from 'vitest';
const core = require('../media/mindmap-core.js');

const {
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
  generateId,
  NODE_PADDING_X,
  NODE_PADDING_Y,
  MAX_NODE_WIDTH,
  LINE_HEIGHT_RATIO,
  IMAGE_THUMBNAIL_WIDTH,
  IMAGE_THUMBNAIL_HEIGHT,
  IMAGE_PADDING,
  NODE_GAP_X,
  NODE_GAP_Y,
} = core;

// ─── parseMarkdown ─────────────────────────────────────────────
describe('parseMarkdown', () => {
  it('should parse H1 as root node', () => {
    const tree = parseMarkdown('# My Root');
    expect(tree.text).toBe('My Root');
    expect(tree.headingLevel).toBe(1);
    expect(tree.children).toEqual([]);
  });

  it('should return default node for empty text', () => {
    const tree = parseMarkdown('');
    expect(tree.text).toBe('Central Topic');
    expect(tree.children).toEqual([]);
  });

  it('should parse list items as children of H1', () => {
    const md = '# Root\n- Child 1\n- Child 2';
    const tree = parseMarkdown(md);
    expect(tree.children).toHaveLength(2);
    expect(tree.children[0].text).toBe('Child 1');
    expect(tree.children[1].text).toBe('Child 2');
  });

  it('should parse nested list items', () => {
    const md = '# Root\n- Parent\n  - Child\n    - Grandchild';
    const tree = parseMarkdown(md);
    expect(tree.children[0].text).toBe('Parent');
    expect(tree.children[0].children[0].text).toBe('Child');
    expect(tree.children[0].children[0].children[0].text).toBe('Grandchild');
  });

  it('should parse H2 as child of H1', () => {
    const md = '# Root\n## Section';
    const tree = parseMarkdown(md);
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].text).toBe('Section');
    expect(tree.children[0].headingLevel).toBe(2);
  });

  it('should parse H3 as child of H2', () => {
    const md = '# Root\n## Section\n### SubSection';
    const tree = parseMarkdown(md);
    const h2 = tree.children[0];
    expect(h2.children).toHaveLength(1);
    expect(h2.children[0].text).toBe('SubSection');
    expect(h2.children[0].headingLevel).toBe(3);
  });

  it('should parse H4 as child of H3', () => {
    const md = '# Root\n## S\n### SS\n#### SSS';
    const tree = parseMarkdown(md);
    const h4 = tree.children[0].children[0].children[0];
    expect(h4.text).toBe('SSS');
    expect(h4.headingLevel).toBe(4);
  });

  it('should handle multiple H2 siblings', () => {
    const md = '# Root\n## A\n## B\n## C';
    const tree = parseMarkdown(md);
    expect(tree.children).toHaveLength(3);
    expect(tree.children[0].text).toBe('A');
    expect(tree.children[1].text).toBe('B');
    expect(tree.children[2].text).toBe('C');
  });

  it('should handle H2 with list items, then another H2', () => {
    const md = '# Root\n## A\n- item1\n- item2\n## B\n- item3';
    const tree = parseMarkdown(md);
    expect(tree.children).toHaveLength(2);
    expect(tree.children[0].text).toBe('A');
    expect(tree.children[0].children).toHaveLength(2);
    expect(tree.children[1].text).toBe('B');
    expect(tree.children[1].children).toHaveLength(1);
  });

  it('should handle complex heading + list hierarchy', () => {
    const md = [
      '# Root',
      '## Section A',
      '- item 1',
      '  - sub item',
      '### SubSection',
      '- sub section item',
      '## Section B',
      '#### Deep',
      '- deep item',
    ].join('\n');
    const tree = parseMarkdown(md);

    // Root has 2 H2 children
    expect(tree.children).toHaveLength(2);

    // Section A
    const sA = tree.children[0];
    expect(sA.text).toBe('Section A');
    expect(sA.headingLevel).toBe(2);
    // Section A has: item 1, SubSection
    expect(sA.children).toHaveLength(2);
    expect(sA.children[0].text).toBe('item 1');
    expect(sA.children[0].children[0].text).toBe('sub item');
    expect(sA.children[1].text).toBe('SubSection');
    expect(sA.children[1].headingLevel).toBe(3);
    expect(sA.children[1].children[0].text).toBe('sub section item');

    // Section B
    const sB = tree.children[1];
    expect(sB.text).toBe('Section B');
    expect(sB.children).toHaveLength(1);
    expect(sB.children[0].text).toBe('Deep');
    expect(sB.children[0].headingLevel).toBe(4);
    expect(sB.children[0].children[0].text).toBe('deep item');
  });

  it('should parse image attached to list item', () => {
    const md = '# Root\n- item\n  ![alt](image.png)';
    const tree = parseMarkdown(md);
    expect(tree.children[0].image).toBe('image.png');
  });

  it('should parse image with size', () => {
    const md = '# Root\n- item\n  ![](pic.jpg =200x150)';
    const tree = parseMarkdown(md);
    expect(tree.children[0].image).toBe('pic.jpg');
    expect(tree.children[0].imageWidth).toBe(200);
    expect(tree.children[0].imageHeight).toBe(150);
  });

  it('should not attach image without preceding list item', () => {
    const md = '# Root\n![](orphan.png)\n- item';
    const tree = parseMarkdown(md);
    expect(tree.children[0].text).toBe('item');
    expect(tree.children[0].image).toBeUndefined();
  });

  it('should ignore headings beyond H4 (H5+)', () => {
    const md = '# Root\n##### H5';
    const tree = parseMarkdown(md);
    // H5 should not be matched by the heading regex
    expect(tree.children).toHaveLength(0);
  });

  it('should handle H3 directly under H1 (skipping H2)', () => {
    const md = '# Root\n### Direct H3';
    const tree = parseMarkdown(md);
    // H3 should become child of H1 since no H2 exists
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].text).toBe('Direct H3');
    expect(tree.children[0].headingLevel).toBe(3);
  });

  it('should assign unique IDs to all nodes', () => {
    const md = '# Root\n## A\n- item\n## B';
    const tree = parseMarkdown(md);
    const ids = new Set();
    function collectIds(node) {
      ids.add(node.id);
      for (const child of node.children) collectIds(child);
    }
    collectIds(tree);
    expect(ids.size).toBe(4); // Root, A, item, B
  });

  it('should not have headingLevel on list items', () => {
    const md = '# Root\n- item';
    const tree = parseMarkdown(md);
    expect(tree.children[0].headingLevel).toBeUndefined();
  });
});

// ─── serializeToMarkdown ────────────────────────────────────────
describe('serializeToMarkdown', () => {
  it('should serialize root only', () => {
    const node = { text: 'Root', children: [], headingLevel: 1 };
    expect(serializeToMarkdown(node)).toBe('# Root\n');
  });

  it('should serialize list items with indent', () => {
    const node = {
      text: 'Root',
      headingLevel: 1,
      children: [
        { text: 'A', children: [{ text: 'A1', children: [] }] },
        { text: 'B', children: [] },
      ],
    };
    const result = serializeToMarkdown(node);
    expect(result).toBe('# Root\n- A\n  - A1\n- B\n');
  });

  it('should serialize H2 children as ## headings', () => {
    const node = {
      text: 'Root',
      headingLevel: 1,
      children: [
        { text: 'Section', headingLevel: 2, children: [] },
      ],
    };
    const result = serializeToMarkdown(node);
    expect(result).toBe('# Root\n## Section\n');
  });

  it('should serialize H3 children as ### headings', () => {
    const node = {
      text: 'Root',
      headingLevel: 1,
      children: [
        {
          text: 'Section',
          headingLevel: 2,
          children: [
            { text: 'Sub', headingLevel: 3, children: [] },
          ],
        },
      ],
    };
    const result = serializeToMarkdown(node);
    expect(result).toBe('# Root\n## Section\n### Sub\n');
  });

  it('should restart indent at depth=0 under heading nodes', () => {
    const node = {
      text: 'Root',
      headingLevel: 1,
      children: [
        {
          text: 'Section',
          headingLevel: 2,
          children: [
            { text: 'item under heading', children: [] },
          ],
        },
      ],
    };
    const result = serializeToMarkdown(node);
    expect(result).toBe('# Root\n## Section\n- item under heading\n');
  });

  it('should serialize images on list items', () => {
    const node = {
      text: 'Root',
      headingLevel: 1,
      children: [
        { text: 'pic', image: 'a.png', children: [] },
      ],
    };
    expect(serializeToMarkdown(node)).toBe('# Root\n- pic\n  ![](a.png)\n');
  });

  it('should serialize images with size', () => {
    const node = {
      text: 'Root',
      headingLevel: 1,
      children: [
        { text: 'pic', image: 'b.jpg', imageWidth: 300, imageHeight: 200, children: [] },
      ],
    };
    expect(serializeToMarkdown(node)).toContain('![](b.jpg =300x200)');
  });

  it('should serialize images on heading nodes', () => {
    const node = {
      text: 'Root',
      headingLevel: 1,
      children: [
        { text: 'Sec', headingLevel: 2, image: 'h.png', children: [] },
      ],
    };
    const result = serializeToMarkdown(node);
    expect(result).toBe('# Root\n## Sec\n![](h.png)\n');
  });

  it('should round-trip parse→serialize→parse', () => {
    const md = [
      '# My Project',
      '## Architecture',
      '- Components',
      '  - Header',
      '  - Footer',
      '### Backend',
      '- API',
      '## Testing',
      '- Unit tests',
      '#### Deep nested heading',
    ].join('\n');
    const tree1 = parseMarkdown(md);
    const serialized = serializeToMarkdown(tree1);
    const tree2 = parseMarkdown(serialized);

    // Compare structure (ignore IDs)
    function compareStructure(a, b) {
      expect(a.text).toBe(b.text);
      expect(a.headingLevel).toBe(b.headingLevel);
      expect(a.children.length).toBe(b.children.length);
      for (let i = 0; i < a.children.length; i++) {
        compareStructure(a.children[i], b.children[i]);
      }
    }
    compareStructure(tree1, tree2);
  });
});

// ─── wrapText ───────────────────────────────────────────────────
describe('wrapText', () => {
  it('should not wrap short text', () => {
    const lines = wrapText('Hi', 14, 300);
    expect(lines).toEqual(['Hi']);
  });

  it('should wrap long text into multiple lines', () => {
    const longText = 'A'.repeat(100);
    const lines = wrapText(longText, 14, 300);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('')).toBe(longText);
  });

  it('should respect maxWidth for wrapping', () => {
    const text = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
    const fontSize = 14;
    const charWidth = fontSize * 0.6;
    const availableWidth = 300 - NODE_PADDING_X * 2;
    const expectedCharsPerLine = Math.floor(availableWidth / charWidth);

    const lines = wrapText(text, fontSize, 300);
    // First line should have exactly expectedCharsPerLine characters
    expect(lines[0].length).toBe(expectedCharsPerLine);
  });

  it('should handle single character', () => {
    const lines = wrapText('X', 14, 300);
    expect(lines).toEqual(['X']);
  });

  it('should handle text exactly at boundary', () => {
    const fontSize = 14;
    const charWidth = fontSize * 0.6;
    const availableWidth = 300 - NODE_PADDING_X * 2;
    const exactChars = Math.floor(availableWidth / charWidth);
    const text = 'A'.repeat(exactChars);
    const lines = wrapText(text, fontSize, 300);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(text);
  });
});

// ─── measureTextWidth ───────────────────────────────────────────
describe('measureTextWidth', () => {
  it('should return minimum for empty string', () => {
    const w = measureTextWidth('', 14);
    expect(w).toBe(NODE_PADDING_X * 2);
  });

  it('should increase with text length', () => {
    const w1 = measureTextWidth('AB', 14);
    const w2 = measureTextWidth('ABCD', 14);
    expect(w2).toBeGreaterThan(w1);
  });

  it('should increase with font size', () => {
    const w1 = measureTextWidth('Test', 12);
    const w2 = measureTextWidth('Test', 16);
    expect(w2).toBeGreaterThan(w1);
  });
});

// ─── getFontSize ────────────────────────────────────────────────
describe('getFontSize', () => {
  it('should return 16 for depth 0', () => {
    expect(getFontSize(0)).toBe(16);
  });

  it('should return 14 for depth 1', () => {
    expect(getFontSize(1)).toBe(14);
  });

  it('should return 13 for depth >= 2', () => {
    expect(getFontSize(2)).toBe(13);
    expect(getFontSize(5)).toBe(13);
  });
});

// ─── getNodeHeight ──────────────────────────────────────────────
describe('getNodeHeight', () => {
  it('should return text height for no image', () => {
    const h = getNodeHeight(0, 0);
    expect(h).toBe(16 + NODE_PADDING_Y * 2);
  });

  it('should add image height when present', () => {
    const h = getNodeHeight(0, 80);
    expect(h).toBe(16 + NODE_PADDING_Y * 2 + 80 + IMAGE_PADDING);
  });
});

// ─── layoutTree ─────────────────────────────────────────────────
describe('layoutTree', () => {
  it('should create layout node with correct properties', () => {
    const node = { id: 'n1', text: 'Test', children: [] };
    const layout = layoutTree(node, 0, 0);
    expect(layout.id).toBe('n1');
    expect(layout.text).toBe('Test');
    expect(layout.depth).toBe(0);
    expect(layout.branchIndex).toBe(0);
    expect(layout.textLines).toEqual(['Test']);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });

  it('should clamp width to MAX_NODE_WIDTH for long text', () => {
    const longText = 'A'.repeat(200);
    const node = { id: 'n1', text: longText, children: [] };
    const layout = layoutTree(node, 0, 0);
    expect(layout.width).toBeLessThanOrEqual(MAX_NODE_WIDTH);
  });

  it('should wrap long text into multiple textLines', () => {
    const longText = 'A'.repeat(200);
    const node = { id: 'n1', text: longText, children: [] };
    const layout = layoutTree(node, 0, 0);
    expect(layout.textLines.length).toBeGreaterThan(1);
    expect(layout.textLines.join('')).toBe(longText);
  });

  it('should increase height for multi-line text', () => {
    const shortNode = { id: 'n1', text: 'Short', children: [] };
    const longNode = { id: 'n2', text: 'A'.repeat(200), children: [] };
    const shortLayout = layoutTree(shortNode, 0, 0);
    const longLayout = layoutTree(longNode, 0, 0);
    expect(longLayout.height).toBeGreaterThan(shortLayout.height);
  });

  it('should layout children recursively', () => {
    const node = {
      id: 'root',
      text: 'Root',
      children: [
        { id: 'c1', text: 'Child 1', children: [] },
        { id: 'c2', text: 'Child 2', children: [] },
      ],
    };
    const layout = layoutTree(node, 0, 0);
    expect(layout.children).toHaveLength(2);
    expect(layout.children[0].depth).toBe(1);
    expect(layout.children[1].depth).toBe(1);
  });

  it('should not layout children when collapsed', () => {
    const node = {
      id: 'root',
      text: 'Root',
      collapsed: true,
      children: [{ id: 'c1', text: 'Child', children: [] }],
    };
    const layout = layoutTree(node, 0, 0);
    expect(layout.children).toHaveLength(0);
    expect(layout.hasChildren).toBe(true);
  });

  it('should assign branch index correctly', () => {
    const node = {
      id: 'root',
      text: 'Root',
      children: [
        { id: 'c0', text: 'A', children: [] },
        { id: 'c1', text: 'B', children: [] },
      ],
    };
    const layout = layoutTree(node, 0, 0);
    expect(layout.children[0].branchIndex).toBe(0);
    expect(layout.children[1].branchIndex).toBe(1);
  });

  it('should include headingLevel in layout node', () => {
    const node = { id: 'n1', text: 'Section', headingLevel: 2, children: [] };
    const layout = layoutTree(node, 1, 0);
    expect(layout.headingLevel).toBe(2);
  });

  it('should handle image nodes with correct dimensions', () => {
    const node = { id: 'n1', text: 'Pic', image: 'img.png', children: [] };
    const layout = layoutTree(node, 0, 0);
    expect(layout.image).toBe('img.png');
    expect(layout.width).toBeGreaterThanOrEqual(IMAGE_THUMBNAIL_WIDTH + NODE_PADDING_X * 2);
    expect(layout.height).toBeGreaterThan(layout.textLines.length * getFontSize(0) * LINE_HEIGHT_RATIO + NODE_PADDING_Y * 2);
  });
});

// ─── computeSubtreeHeight ───────────────────────────────────────
describe('computeSubtreeHeight', () => {
  it('should return node height for leaf', () => {
    const node = { id: 'n1', text: 'Leaf', children: [] };
    const layout = layoutTree(node, 0, 0);
    expect(computeSubtreeHeight(layout)).toBe(layout.height);
  });

  it('should account for children + gaps', () => {
    const node = {
      id: 'root',
      text: 'Root',
      children: [
        { id: 'c1', text: 'A', children: [] },
        { id: 'c2', text: 'B', children: [] },
      ],
    };
    const layout = layoutTree(node, 0, 0);
    const h1 = computeSubtreeHeight(layout.children[0]);
    const h2 = computeSubtreeHeight(layout.children[1]);
    const expected = h1 + h2 + NODE_GAP_Y;
    expect(computeSubtreeHeight(layout)).toBe(Math.max(layout.height, expected));
  });
});

// ─── positionNodes ──────────────────────────────────────────────
describe('positionNodes', () => {
  it('should position root at specified coordinates', () => {
    const node = { id: 'root', text: 'Root', children: [] };
    const layout = layoutTree(node, 0, 0);
    positionNodes(layout, 10, 20);
    expect(layout.x).toBe(10);
    expect(layout.y).toBeCloseTo(20, 5);
  });

  it('should position children to the right of parent', () => {
    const node = {
      id: 'root',
      text: 'Root',
      children: [
        { id: 'c1', text: 'Child', children: [] },
      ],
    };
    const layout = layoutTree(node, 0, 0);
    positionNodes(layout, 0, 0);
    expect(layout.children[0].x).toBe(layout.width + NODE_GAP_X);
  });

  it('should space children vertically', () => {
    const node = {
      id: 'root',
      text: 'Root',
      children: [
        { id: 'c1', text: 'A', children: [] },
        { id: 'c2', text: 'B', children: [] },
      ],
    };
    const layout = layoutTree(node, 0, 0);
    positionNodes(layout, 0, 0);
    expect(layout.children[1].y).toBeGreaterThan(layout.children[0].y);
  });
});

// ─── preserveCollapsedState ─────────────────────────────────────
describe('preserveCollapsedState', () => {
  it('should copy collapsed state', () => {
    const oldNode = { collapsed: true, children: [] };
    const newNode = { children: [] };
    preserveCollapsedState(oldNode, newNode);
    expect(newNode.collapsed).toBe(true);
  });

  it('should copy headingLevel', () => {
    const oldNode = { headingLevel: 2, children: [] };
    const newNode = { children: [] };
    preserveCollapsedState(oldNode, newNode);
    expect(newNode.headingLevel).toBe(2);
  });

  it('should copy image properties', () => {
    const oldNode = { image: 'pic.png', imageWidth: 100, imageHeight: 50, children: [] };
    const newNode = { children: [] };
    preserveCollapsedState(oldNode, newNode);
    expect(newNode.image).toBe('pic.png');
    expect(newNode.imageWidth).toBe(100);
    expect(newNode.imageHeight).toBe(50);
  });

  it('should recurse into children', () => {
    const oldNode = {
      collapsed: true,
      children: [{ collapsed: true, headingLevel: 3, children: [] }],
    };
    const newNode = { children: [{ children: [] }] };
    preserveCollapsedState(oldNode, newNode);
    expect(newNode.children[0].collapsed).toBe(true);
    expect(newNode.children[0].headingLevel).toBe(3);
  });

  it('should handle mismatched children lengths', () => {
    const oldNode = {
      children: [
        { collapsed: true, children: [] },
        { collapsed: true, children: [] },
      ],
    };
    const newNode = { children: [{ children: [] }] };
    // Should not throw
    preserveCollapsedState(oldNode, newNode);
    expect(newNode.children[0].collapsed).toBe(true);
  });
});

// ─── generateId ─────────────────────────────────────────────────
describe('generateId', () => {
  it('should return a non-empty string', () => {
    const id = generateId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('should generate unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
});

// ─── Integration: full pipeline ─────────────────────────────────
describe('Integration', () => {
  it('should parse, layout, and position a complex tree', () => {
    const md = [
      '# Project',
      '## Frontend',
      '- React components',
      '  - Header',
      '  - Sidebar',
      '### Styling',
      '- CSS modules',
      '## Backend',
      '- Express server',
      '#### Database layer',
      '- PostgreSQL',
    ].join('\n');

    const tree = parseMarkdown(md);
    const layout = layoutTree(tree, 0, 0);
    positionNodes(layout, 0, 0);

    // Verify full tree positioned without NaN or negative values
    function verifyPositions(node) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
      expect(node.width).toBeGreaterThan(0);
      expect(node.height).toBeGreaterThan(0);
      for (const child of node.children) {
        verifyPositions(child);
      }
    }
    verifyPositions(layout);
  });

  it('should handle long text with wrapping in full pipeline', () => {
    const longText = 'This is a very long node text that should definitely be wrapped because it exceeds the maximum node width of 300 pixels';
    const md = `# Root\n- ${longText}`;
    const tree = parseMarkdown(md);
    const layout = layoutTree(tree, 0, 0);

    const childLayout = layout.children[0];
    expect(childLayout.textLines.length).toBeGreaterThan(1);
    expect(childLayout.width).toBeLessThanOrEqual(MAX_NODE_WIDTH);
  });

  it('should serialize and re-parse heading hierarchy identically', () => {
    const md = [
      '# Root',
      '## H2-A',
      '- list under H2-A',
      '### H3-A',
      '- list under H3-A',
      '## H2-B',
      '#### H4-B',
    ].join('\n');

    const tree1 = parseMarkdown(md);
    const serialized = serializeToMarkdown(tree1);
    const tree2 = parseMarkdown(serialized);

    function getStructure(node) {
      return {
        text: node.text,
        hl: node.headingLevel,
        children: node.children.map(getStructure),
      };
    }

    expect(getStructure(tree1)).toEqual(getStructure(tree2));
  });
});
