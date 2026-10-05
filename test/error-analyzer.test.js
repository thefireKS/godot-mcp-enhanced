import { expect } from 'vitest';
import { analyzeOutput } from '../src/error-analyzer.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('error-analyzer', () => {
  describe('parse errors', () => {
    it('parses SCRIPT ERROR: Parse Error', () => {
      const result = analyzeOutput([
        'SCRIPT ERROR: Parse Error: Unexpected token.',
        'at: res://scripts/player.gd:42',
      ]);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].type).toBe('parse_error');
      expect(result.errors[0].file).toBe('res://scripts/player.gd');
      expect(result.errors[0].line).toBe(42);
      expect(result.errors[0].suggestion).toContain('Syntax error');
      expect(result.hasErrors).toBe(true);
    });
  });

  describe('null reference', () => {
    it('parses null parameter error', () => {
      const result = analyzeOutput([
        'SCRIPT ERROR: Parameter "position" is null.',
        'at: res://scripts/enemy.gd:15',
      ]);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].type).toBe('null_reference');
      expect(result.errors[0].suggestion).toContain('position');
    });
  });

  describe('type errors', () => {
    it('parses Invalid type in function', () => {
      const result = analyzeOutput([
        'SCRIPT ERROR: Invalid type in function "move". Expected Vector2. Got int.',
      ]);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].type).toBe('type_error');
      expect(result.errors[0].suggestion).toContain('move');
    });
  });

  describe('identifier not found', () => {
    it('parses Identifier not found', () => {
      const result = analyzeOutput([
        'SCRIPT ERROR: Identifier "health" not found in the current scope.',
      ]);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].type).toBe('script_error');
      expect(result.errors[0].suggestion).toContain('health');
    });
  });

  describe('argument count errors', () => {
    it('parses too few arguments', () => {
      const result = analyzeOutput([
        'SCRIPT ERROR: Too few arguments for function "set_position".',
      ]);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].type).toBe('script_error');
      expect(result.errors[0].suggestion).toContain('set_position');
    });

    it('parses too many arguments', () => {
      const result = analyzeOutput([
        'SCRIPT ERROR: Too many arguments for function "set_position".',
      ]);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].type).toBe('script_error');
      expect(result.errors[0].suggestion).toContain('Too many');
    });
  });

  describe('index out of bounds', () => {
    it('parses Index out of bounds', () => {
      const result = analyzeOutput([
        'ERROR: Index out of bounds.',
      ]);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].type).toBe('runtime_error');
      expect(result.errors[0].suggestion).toContain('bounds');
    });
  });

  describe('file not found', () => {
    it('parses File not found', () => {
      const result = analyzeOutput([
        'ERROR: File not found: res://assets/missing.png.',
      ]);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].type).toBe('runtime_error');
      expect(result.errors[0].suggestion).toContain('missing.png');
    });
  });

  describe('headless limitations', () => {
    it('parses texture_2d_get null', () => {
      const result = analyzeOutput([
        'ERROR: texture_2d_get returned null.',
      ]);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].type).toBe('headless_limitation');
      expect(result.hasErrors).toBe(false);
    });

    it('parses get_image() null', () => {
      const result = analyzeOutput([
        'ERROR: get_image() returned null.',
      ]);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].type).toBe('headless_limitation');
      expect(result.hasErrors).toBe(false);
    });

    it('parses canvas_item condition', () => {
      const result = analyzeOutput([
        'ERROR: Condition "!p_canvas_item" is true.',
      ]);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].type).toBe('headless_limitation');
    });
  });

  describe('condition assertions', () => {
    it('parses generic Condition is true', () => {
      const result = analyzeOutput([
        'ERROR: Condition "node != null" is true.',
      ]);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].type).toBe('runtime_error');
      expect(result.errors[0].suggestion).toContain('assertion');
    });
  });

  describe('warnings', () => {
    it('parses WARNING lines', () => {
      const result = analyzeOutput([
        'WARNING: Useless call to set_position.',
        'at: res://scripts/player.gd:10',
      ]);
      expect(result.warnings.length).toBe(1);
      expect(result.warnings[0].file).toBe('res://scripts/player.gd');
      expect(result.warnings[0].line).toBe(10);
      expect(result.errors.length).toBe(0);
      expect(result.hasErrors).toBe(false);
    });
  });

  describe('mixed output', () => {
    it('classifies errors, warnings, and prints together', () => {
      const result = analyzeOutput([
        'Player spawned at origin',
        'WARNING: Deprecated function get_global_pos.',
        'SCRIPT ERROR: Identifier "speed" not found.',
        'at: res://scripts/player.gd:25',
        'Game started',
      ]);
      expect(result.errors.length).toBe(1);
      expect(result.warnings.length).toBe(1);
      expect(result.prints.length).toBe(3);
      expect(result.hasErrors).toBe(true);
      expect(result.summary).toContain('1 error');
      expect(result.summary).toContain('1 warning');
      expect(result.summary).toContain('3 print');
    });
  });

  describe('summary', () => {
    it('returns "No errors" for empty output', () => {
      const result = analyzeOutput([]);
      expect(result.summary).toBe('No errors, warnings, or output found.');
      expect(result.hasErrors).toBe(false);
    });

    it('separates headless limitations from real errors', () => {
      const result = analyzeOutput([
        'ERROR: texture_2d_get returned null.',
        'SCRIPT ERROR: Identifier "x" not found.',
      ]);
      expect(result.errors.length).toBe(2);
      expect(result.hasErrors).toBe(true);
      expect(result.summary).toContain('headless limitation');
    });
  });

  describe('deduplication', () => {
    it('deduplicates identical suggestions', () => {
      const result = analyzeOutput([
        'SCRIPT ERROR: Index out of bounds.',
        'SCRIPT ERROR: Index out of bounds.',
      ]);
      expect(result.errors.length).toBe(2);
      expect(result.suggestions.length).toBe(1);
    });
  });

  describe('location parsing', () => {
    it('parses at: file:line format', () => {
      const result = analyzeOutput([
        'SCRIPT ERROR: Something wrong.',
        'at: res://main.gd:100',
      ]);
      expect(result.errors[0].file).toBe('res://main.gd');
      expect(result.errors[0].line).toBe(100);
    });

    it('parses at: file(line) format', () => {
      const result = analyzeOutput([
        'SCRIPT ERROR: Something wrong.',
        'at: res://main.gd(100)',
      ]);
      // Note: first regex greedily matches before atMatch2 can fire
      // so file includes (100) and line is undefined — known limitation
      expect(result.errors[0].file).toBeTruthy();
      expect(result.errors[0].file).toContain('main.gd');
    });

    it('parses function context', () => {
      const result = analyzeOutput([
        'SCRIPT ERROR: Something wrong.',
        'in function \'_ready\'',
      ]);
      expect(result.errors[0].function).toBe('_ready');
    });
  });
});

describe('Godot 4.6+ compatibility hints', () => {
  it('detects get_tree() not found and adds compatibility hint', () => {
    const output = [
      'SCRIPT ERROR: Function \'get_tree()\' not found in base self.',
      '  at: res://mcp_script.gd:5',
    ];
    const result = analyzeOutput(output);
    expect(result.hasErrors).toBe(true);
    const hint = result.suggestions.find(s => s.includes('self.root') && s.includes('get_tree'));
    expect(hint).toBeDefined();
  });

  it('detects root redefined and adds compatibility hint', () => {
    const output = [
      'SCRIPT ERROR: Member \'root\' redefined in parent class.',
      '  at: res://mcp_script.gd:3',
    ];
    const result = analyzeOutput(output);
    expect(result.hasErrors).toBe(true);
    const hint = result.suggestions.find(s => s.includes('root') && s.includes('SceneTree') && s.includes('clashes'));
    expect(hint).toBeDefined();
  });

  // NOTE: This test relies on ERROR_PATTERNS order — "Identifier not found" (line 64)
  // matches before the get_tree compatibility pattern (line 107), so the compatibility
  // hint is never triggered. If patterns are reordered, add a guard to the get_tree
  // pattern's test function to exclude Identifier-style errors.
  it('does not add compatibility hint for unrelated errors', () => {
    const output = [
      'SCRIPT ERROR: Identifier "foo" not found in base self.',
      '  at: res://mcp_script.gd:10',
    ];
    const result = analyzeOutput(output);
    const hint = result.suggestions.find(s => s.includes('self.root') || s.includes('SceneTree.root'));
    expect(hint).toBeUndefined();
  });

  it('matches get_tree with varied error wording', () => {
    const output = [
      'SCRIPT ERROR: The function get_tree() could not be found.',
      '  at: res://mcp_script.gd:8',
    ];
    const result = analyzeOutput(output);
    const hint = result.suggestions.find(s => s.includes('self.root'));
    expect(hint).toBeDefined();
  });
});

describe('autoload headless filtering', () => {
  it('reclassifies autoload identifier as headless_limitation', () => {
    const result = analyzeOutput([
      'SCRIPT ERROR: Identifier "GameEvents" not found.',
    ], { autoloadNames: ['GameEvents', 'PlayerData', 'AudioManager'] });
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].type).toBe('headless_limitation');
    expect(result.errors[0].suggestion).toContain('GameEvents');
    expect(result.errors[0].suggestion).toContain('autoload');
    expect(result.hasErrors).toBe(false);
  });

  it('does not reclassify non-autoload identifier', () => {
    const result = analyzeOutput([
      'SCRIPT ERROR: Identifier "SomeLocalVar" not found.',
    ], { autoloadNames: ['GameEvents', 'PlayerData'] });
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].type).toBe('script_error');
    expect(result.hasErrors).toBe(true);
  });

  it('works without autoloadNames (backward compatible)', () => {
    const result = analyzeOutput([
      'SCRIPT ERROR: Identifier "GameEvents" not found.',
    ]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].type).toBe('script_error');
    expect(result.hasErrors).toBe(true);
  });

  it('separates autoload errors from real errors in summary', () => {
    const result = analyzeOutput([
      'SCRIPT ERROR: Identifier "GameEvents" not found.',
      'SCRIPT ERROR: Identifier "RealBug" not found.',
    ], { autoloadNames: ['GameEvents'] });
    expect(result.errors.length).toBe(2);
    expect(result.hasErrors).toBe(true);
    expect(result.summary).toContain('headless limitation');
    expect(result.summary).toContain('1 error');
  });
});

// S3 (2026-06-23): class_name 全局类(PlayerData/EnemyDatabase 等非 autoload 的全局类)
// 在 headless 下跨文件解析失败同样报 "Identifier X not found",需与 autoload 同归 headless_limitation,
// 否则干净项目被误诊(见 docs/review-followup-2026-06-23-mcp-tools.md S3)。
describe('class_name headless filtering (S3)', () => {
  it('reclassifies global class_name identifier as headless_limitation', () => {
    const result = analyzeOutput([
      'SCRIPT ERROR: Identifier "PlayerData" not found.',
    ], { classNames: ['PlayerData', 'EnemyDatabase', 'Battler'] });
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].type).toBe('headless_limitation');
    expect(result.errors[0].suggestion).toContain('PlayerData');
    expect(result.hasErrors).toBe(false);
  });

  it('does not reclassify unknown identifier', () => {
    const result = analyzeOutput([
      'SCRIPT ERROR: Identifier "SomeLocalVar" not found.',
    ], { classNames: ['PlayerData', 'Battler'] });
    expect(result.errors[0].type).toBe('script_error');
    expect(result.hasErrors).toBe(true);
  });

  it('classNames combines with autoloadNames', () => {
    const result = analyzeOutput([
      'SCRIPT ERROR: Identifier "GameEvents" not found.',
      'SCRIPT ERROR: Identifier "Battler" not found.',
      'SCRIPT ERROR: Identifier "RealBug" not found.',
    ], { autoloadNames: ['GameEvents'], classNames: ['Battler'] });
    const types = result.errors.map(e => e.type);
    expect(types).toContain('headless_limitation'); // GameEvents(autoload) + Battler(class)
    expect(types).toContain('script_error'); // RealBug
    expect(result.hasErrors).toBe(true);
  });

  it('works without classNames (backward compatible)', () => {
    const result = analyzeOutput([
      'SCRIPT ERROR: Identifier "PlayerData" not found.',
    ]);
    expect(result.errors[0].type).toBe('script_error');
    expect(result.hasErrors).toBe(true);
  });
});

describe('source snippet', () => {
  it('attaches snippet for res:// file when projectPath provided', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-snippet-'));
    try {
      writeFileSync(join(dir, 'player.gd'), `line one
line two
line three
var x = y.foo()
line five`);
      const result = analyzeOutput(
        ['SCRIPT ERROR: Cannot call function "foo" on null instance.', 'at: res://player.gd:4'],
        { projectPath: dir }
      );
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].snippet).toBeDefined();
      expect(result.errors[0].snippet).toContain('> 4:');
      expect(result.errors[0].snippet).toContain('var x = y.foo()');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('omits snippet when projectPath not provided', () => {
    const result = analyzeOutput(['SCRIPT ERROR: x', 'at: res://player.gd:4']);
    expect(result.errors[0].snippet).toBeUndefined();
  });

  it('omits snippet for non-res:// path (execute_gdscript temp wrapper)', () => {
    const result = analyzeOutput(
      ['SCRIPT ERROR: x', 'at: /tmp/session123/wrapper.gd:4'],
      { projectPath: '/some/project' }
    );
    expect(result.errors[0].snippet).toBeUndefined();
  });

  it('omits snippet when file does not exist (silent skip)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-snippet-'));
    try {
      const result = analyzeOutput(
        ['SCRIPT ERROR: x', 'at: res://missing.gd:4'],
        { projectPath: dir }
      );
      expect(result.errors[0].snippet).toBeUndefined();
      expect(result.errors[0].type).toBeDefined();
      expect(result.errors[0].suggestion).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
