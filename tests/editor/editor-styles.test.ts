import { describe, expect, it } from 'vitest';

import { EDITOR_STYLES } from '../../src/editor/editor-styles';

describe('editor panel styles', () => {
  it('allows expanded picker overlays to escape panel boundaries', () => {
    expect(EDITOR_STYLES.cssText).toMatch(/\.section\.panel\s*{[^}]*overflow:\s*visible;/s);
    expect(EDITOR_STYLES.cssText).toMatch(/\.section\.panel\.collapsed\s*{[^}]*overflow:\s*hidden;/s);
  });
});
