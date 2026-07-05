export function uniqueEntitiesById<T extends { entity_id: string }>(entities: readonly T[]): T[] {
  const seenEntityIds = new Set<string>();
  return entities.filter((entity) => {
    if (seenEntityIds.has(entity.entity_id)) return false;
    seenEntityIds.add(entity.entity_id);
    return true;
  });
}
