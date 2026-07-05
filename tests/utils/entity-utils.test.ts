import { describe, expect, it } from 'vitest';

import { uniqueEntitiesById } from '../../src/utils/entity-utils';

describe('uniqueEntitiesById', () => {
  it('keeps the first occurrence of each entity id', () => {
    const light = { entity_id: 'light.living_room', source: 'first' };
    const duplicateLight = { entity_id: 'light.living_room', source: 'duplicate' };
    const camera = { entity_id: 'camera.driveway', source: 'first' };

    expect(uniqueEntitiesById([light, duplicateLight, camera, camera])).toEqual([light, camera]);
  });
});
