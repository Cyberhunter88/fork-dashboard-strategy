// ====================================================================
// VIEW STRATEGY — ROOM (Room detail with sensor badges + cameras)
// ====================================================================

import type { HomeAssistant, HassEntity } from '../types/homeassistant';
import type {
  LovelaceViewConfig,
  LovelaceCardConfig,
  LovelaceSectionConfig,
  LovelaceBadgeConfig,
} from '../types/lovelace';
import type { AreaRegistryEntry } from '../types/registries';
import type { AreaCustomCard, RoomEntities, SensorEntities, StackKey } from '../types/strategy';
import { mergeStacksOrder, stripAreaName, sortByLastChanged } from '../utils/name-utils';
import { Registry } from '../Registry';
import { timeStart, timeEnd, debugLog } from '../utils/debug';
import { localize } from '../utils/localize';
import { BADGE_COLOR_MAP, getColorForEntity, isDefaultShowName, resolveShowName } from '../utils/badge-utils';

// HA supported_features bitmask values
const FAN_SET_SPEED = 1;
const MEDIA_PAUSE = 1;
const MEDIA_PLAY = 16384;
const MEDIA_STOP = 4096;

/** Check if a fan supports speed control */
function fanSupportsSpeed(state: HassEntity): boolean {
  return ((state.attributes?.supported_features as number) & FAN_SET_SPEED) !== 0;
}

/** Check if a media player supports playback controls */
function mediaPlayerSupportsPlayback(state: HassEntity): boolean {
  const f = (state.attributes?.supported_features as number) || 0;
  return (f & (MEDIA_PAUSE | MEDIA_PLAY | MEDIA_STOP)) !== 0;
}

const UPS_SIGNAL_CLASSES = new Set(['duration', 'apparent_power', 'power', 'voltage']);
const UPS_RUNTIME_PATTERN = /(^|[._])(runtime|time_left|load_runtime)([._]|$)/;
const UPS_LOAD_PATTERN = /(^|[._])load([._]|$)/;
const UPS_VOLTAGE_PATTERN = /(^|[._])(voltage|input_voltage|input)([._]|$)/;
const UPS_STATUS_PATTERN = /(^|[._])(status|state)([._]|$)/;
const UPS_DETECT_ID_PATTERN = /(^|[._])(load|runtime|time_left|input_voltage|input)([._]|$)/;

function upsSensorRole(entityId: string, state: HassEntity): number {
  const dc = state.attributes?.device_class as string | undefined;
  if (dc === 'duration' || UPS_RUNTIME_PATTERN.test(entityId)) return 1;
  if (dc === 'power' || dc === 'apparent_power' || UPS_LOAD_PATTERN.test(entityId)) return 2;
  if (dc === 'voltage' || UPS_VOLTAGE_PATTERN.test(entityId)) return 3;
  if (UPS_STATUS_PATTERN.test(entityId)) return 4;
  return 5;
}

interface UpsDeviceRender {
  name: string;
  batteryId: string;
  sensorIds: string[];
}

interface UpsCandidateEntity {
  entityId: string;
  state: HassEntity;
  platform?: string;
}

function buildAreaCustomCardSection(
  cards: AreaCustomCard[],
  position: 'top' | 'bottom'
): LovelaceSectionConfig[] {
  const sections: LovelaceSectionConfig[] = [];
  const built: LovelaceCardConfig[] = [];

  function flushCards(): void {
    if (built.length === 0) return;
    sections.push({ type: 'grid', cards: built.splice(0) });
  }

  for (const card of cards) {
    if ((card.position || 'bottom') !== position) continue;

    const mode = card.mode || 'yaml';
    if (mode === 'section') {
      if (!card.parsed_config || card._yaml_error) continue;
      const parsedSections = Array.isArray(card.parsed_config) ? card.parsed_config : [card.parsed_config];
      const validSections = parsedSections.filter((section) =>
        section && typeof section === 'object' && Array.isArray((section as LovelaceSectionConfig).cards)
      ) as LovelaceSectionConfig[];

      if (validSections.length === 0) continue;
      flushCards();
      validSections.forEach((section, index) => {
        const sectionConfig: LovelaceSectionConfig = { ...section };
        if (card.title && index === 0) {
          sectionConfig.cards = [
            { type: 'heading', heading: card.title },
            ...((sectionConfig.cards || []) as LovelaceCardConfig[]),
          ];
        }
        sections.push(sectionConfig);
      });
      continue;
    }

    if (mode === 'tile') {
      if (!card.entity) continue;
      if (card.title) built.push({ type: 'heading', heading: card.title });
      built.push({ type: 'tile', entity: card.entity });
      continue;
    }

    if (card.parsed_config && !card._yaml_error && typeof card.parsed_config === 'object') {
      const cardConfigs = Array.isArray(card.parsed_config) ? card.parsed_config : [card.parsed_config];
      if (card.title) built.push({ type: 'heading', heading: card.title });
      built.push(...(cardConfigs as LovelaceCardConfig[]));
    }
  }

  flushCards();
  return sections;
}

class Simon42ViewRoomStrategy extends HTMLElement {
  static async generate(config: any, hass: HomeAssistant): Promise<LovelaceViewConfig> {
    const area: AreaRegistryEntry = config.area;
    debugLog(`room-generate-${area.area_id}: called at ${performance.now().toFixed(1)}ms after page load`);
    timeStart(`room-generate-${area.area_id}`);
    const dashboardConfig = config.dashboardConfig || {};

    // Ensure Registry is initialized (idempotent — no-op if already done)
    Registry.initialize(hass, dashboardConfig);
    const groupsOptions: Record<string, any> = config.groups_options || {};
    const customCards: AreaCustomCard[] = config.custom_cards || [];

    const roomEntities: RoomEntities = {
      lights: [],
      covers: [],
      covers_curtain: [],
      covers_window: [],
      scenes: [],
      climate: [],
      media_player: [],
      vacuum: [],
      fan: [],
      switches: [],
      locks: [],
      automations: [],
      scripts: [],
      cameras: [],
      ups: [],
    };

    const sensorEntities: SensorEntities = {
      temperature: [],
      humidity: [],
      pm25: [],
      pm10: [],
      co2: [],
      voc: [],
      motion: [],
      occupancy: [],
      illuminance: [],
      absolute_humidity: [],
      battery: [],
      window: [],
      door: [],
      smoke: [],
      gas: [],
    };

    // Main categorization loop — use pre-filtered visible entities from Registry
    // (no hidden, no_dboard, config/diagnostic, config-hidden)
    const visibleEntities = Registry.getVisibleEntitiesForArea(area.area_id);

    const showUps = dashboardConfig.show_ups_in_rooms !== false;
    const usedByUps = new Set<string>();
    const upsDevices: UpsDeviceRender[] = [];

    if (showUps) {
      const byDevice = new Map<string, UpsCandidateEntity[]>();
      for (const entity of visibleEntities) {
        const domain = entity.entity_id.split('.')[0];
        if (domain !== 'sensor' && domain !== 'binary_sensor') continue;
        if (!entity.device_id) continue;
        const state = hass.states[entity.entity_id];
        if (!state) continue;
        const entry: UpsCandidateEntity = {
          entityId: entity.entity_id,
          state,
          platform: entity.platform,
        };
        const list = byDevice.get(entity.device_id);
        if (list) list.push(entry);
        else byDevice.set(entity.device_id, [entry]);
      }

      for (const [deviceId, entities] of byDevice) {
        const batteryEntity = entities.find((entry) => {
          const attrs = entry.state.attributes;
          return attrs?.device_class === 'battery' && attrs?.unit_of_measurement === '%';
        });
        const batteryId = batteryEntity?.entityId;
        if (!batteryId) continue;

        const isNut = entities.some((entry) => entry.platform === 'nut');
        const isUps = isNut || entities.some((entry) => {
          if (entry.entityId === batteryId) return false;
          const dc = entry.state.attributes?.device_class as string | undefined;
          return (dc !== undefined && UPS_SIGNAL_CLASSES.has(dc)) || UPS_DETECT_ID_PATTERN.test(entry.entityId);
        });
        if (!isUps) continue;

        const device = Registry.getDevice(deviceId);
        const name = device?.name_by_user ?? device?.name ?? 'UPS';
        for (const entry of entities) usedByUps.add(entry.entityId);

        const sensorIds = entities
          .filter((entry) => entry.entityId !== batteryId)
          .map((entry) => ({ id: entry.entityId, role: upsSensorRole(entry.entityId, entry.state) }))
          .sort((a, b) => a.role - b.role)
          .map((entry) => entry.id);

        upsDevices.push({ name, batteryId, sensorIds });
      }
    }

    for (const ups of upsDevices) roomEntities.ups.push(ups.batteryId);

    for (const entity of visibleEntities) {
      const entityId = entity.entity_id;

      if (usedByUps.has(entityId)) continue;

      // State check
      const state = hass.states[entityId];
      if (!state) continue;

      // Domain categorization
      const domain = entityId.split('.')[0];
      const deviceClass = state.attributes?.device_class as string | undefined;
      const unit = state.attributes?.unit_of_measurement as string | undefined;

      if (domain === 'light') {
        roomEntities.lights.push(entityId);
        continue;
      }
      if (domain === 'cover') {
        if (deviceClass === 'curtain') roomEntities.covers_curtain.push(entityId);
        else if (deviceClass === 'window' || deviceClass === 'door' || deviceClass === 'gate' || deviceClass === 'garage') roomEntities.covers_window.push(entityId);
        else roomEntities.covers.push(entityId);
        continue;
      }
      if (domain === 'scene') {
        roomEntities.scenes.push(entityId);
        continue;
      }
      if (domain === 'climate') {
        roomEntities.climate.push(entityId);
        continue;
      }
      if (domain === 'media_player') {
        roomEntities.media_player.push(entityId);
        continue;
      }
      if (domain === 'vacuum') {
        roomEntities.vacuum.push(entityId);
        continue;
      }
      if (domain === 'fan') {
        roomEntities.fan.push(entityId);
        continue;
      }
      if (domain === 'switch') {
        roomEntities.switches.push(entityId);
        continue;
      }
      if (domain === 'lock' && dashboardConfig.show_locks_in_rooms) {
        roomEntities.locks.push(entityId);
        continue;
      }
      if (domain === 'automation' && dashboardConfig.show_automations_in_rooms) {
        roomEntities.automations.push(entityId);
        continue;
      }
      if (domain === 'script' && dashboardConfig.show_scripts_in_rooms) {
        roomEntities.scripts.push(entityId);
        continue;
      }
      if (domain === 'camera') {
        roomEntities.cameras.push(entityId);
        continue;
      }

      // Sensors for badges
      if (domain === 'sensor') {
        if (entityId.includes('battery') || deviceClass === 'battery') {
          const val = parseFloat(state.state);
          if (!isNaN(val) && val < 20) sensorEntities.battery.push(entityId);
          continue;
        }
        // Temperature and humidity badges are only shown when explicitly
        // assigned in HA area settings (area.temperature_entity_id / humidity_entity_id).
        // No auto-detection — avoids wrong sensors (e.g. heater temperature).
        if (deviceClass === 'temperature' || unit === '°C' || unit === '°F') continue;
        if (deviceClass === 'humidity' || unit === '%') continue;
        if (unit === 'g/m³') {
          sensorEntities.absolute_humidity.push(entityId);
          continue;
        }
        if (deviceClass === 'pm25' || entityId.includes('pm_2_5') || entityId.includes('pm25')) {
          sensorEntities.pm25.push(entityId);
          continue;
        }
        if (deviceClass === 'pm10' || entityId.includes('pm_10') || entityId.includes('pm10')) {
          sensorEntities.pm10.push(entityId);
          continue;
        }
        if (deviceClass === 'carbon_dioxide' || entityId.includes('co2')) {
          sensorEntities.co2.push(entityId);
          continue;
        }
        if (deviceClass === 'volatile_organic_compounds' || entityId.includes('voc')) {
          sensorEntities.voc.push(entityId);
          continue;
        }
        if (deviceClass === 'illuminance' || unit === 'lx') {
          sensorEntities.illuminance.push(entityId);
          continue;
        }
      }
      if (domain === 'binary_sensor') {
        if (deviceClass === 'motion') {
          sensorEntities.motion.push(entityId);
          continue;
        }
        if (deviceClass === 'occupancy' || deviceClass === 'presence') {
          sensorEntities.occupancy.push(entityId);
          continue;
        }
        if (deviceClass === 'window') {
          sensorEntities.window.push(entityId);
          continue;
        }
        if (deviceClass === 'door') {
          sensorEntities.door.push(entityId);
          continue;
        }
        if (deviceClass === 'smoke') {
          sensorEntities.smoke.push(entityId);
          continue;
        }
        if (deviceClass === 'gas') {
          sensorEntities.gas.push(entityId);
          continue;
        }
      }
    }

    // Apply groups_options filters
    const applyGroupFilter = (groupKey: keyof RoomEntities): string[] => {
      const groupOpts = groupsOptions[groupKey];
      if (!groupOpts) return roomEntities[groupKey];
      let filtered = roomEntities[groupKey];
      if (groupOpts.hidden?.length > 0) {
        const hiddenSet = new Set<string>(groupOpts.hidden);
        filtered = filtered.filter((e: string) => !hiddenSet.has(e));
      }
      if (groupOpts.order?.length > 0) {
        const orderMap = new Map<string, number>(groupOpts.order.map((id: string, i: number) => [id, i]));
        filtered.sort((a: string, b: string) => (orderMap.get(a) ?? 9999) - (orderMap.get(b) ?? 9999));
      }
      return filtered;
    };

    for (const key of Object.keys(roomEntities) as (keyof RoomEntities)[]) {
      roomEntities[key] = applyGroupFilter(key);
    }

    // === BADGES ===

    // Primary temp/humidity from area config (always shown, not filterable)
    let primaryTemp: string | null = null;
    let primaryHumidity: string | null = null;

    if (
      area.temperature_entity_id &&
      hass.states[area.temperature_entity_id] &&
      !Registry.isEntityExcluded(area.temperature_entity_id)
    ) {
      primaryTemp = area.temperature_entity_id;
    }
    if (
      area.humidity_entity_id &&
      hass.states[area.humidity_entity_id] &&
      !Registry.isEntityExcluded(area.humidity_entity_id)
    ) {
      primaryHumidity = area.humidity_entity_id;
    }

    // Build auto-detected badge candidates
    const badgeOpts = groupsOptions.badges;
    const hasBadgeConfig = !!badgeOpts;

    interface BadgeCandidate {
      entity: string;
      color: string;
      showName?: boolean;
    }

    const candidates: BadgeCandidate[] = [];

    // Auto-detected sensors (first match per type, except window/door which show all)
    // Colors from shared BADGE_COLOR_MAP, show_name from shared isDefaultShowName()
    const addCandidate = (entityId: string, colorKey: string, dcOverride?: string) => {
      const dc = dcOverride || (hass.states[entityId]?.attributes?.device_class as string | undefined);
      candidates.push({
        entity: entityId,
        color: BADGE_COLOR_MAP[colorKey] || 'grey',
        ...(isDefaultShowName(dc) ? { showName: true } : {}),
      });
    };

    // Single-match sensor types
    const singleTypes: Array<[string[], string]> = [
      [sensorEntities.pm25, 'pm25'],
      [sensorEntities.pm10, 'pm10'],
      [sensorEntities.co2, 'carbon_dioxide'],
      [sensorEntities.voc, 'volatile_organic_compounds'],
      [sensorEntities.illuminance, 'illuminance'],
      [sensorEntities.battery, 'battery'],
      [sensorEntities.motion, 'motion'],
      [sensorEntities.occupancy, 'occupancy'],
      [sensorEntities.absolute_humidity, 'moisture'],
      [sensorEntities.smoke, 'smoke'],
      [sensorEntities.gas, 'gas'],
    ];
    for (const [entities, colorKey] of singleTypes) {
      if (entities[0]) addCandidate(entities[0], colorKey);
    }

    // Window/door: show ALL matches (not just first), users control via per-area hidden[]
    for (const id of sensorEntities.window) addCandidate(id, 'window', 'window');
    for (const id of sensorEntities.door) addCandidate(id, 'door', 'door');

    // Apply per-area badge config: filter hidden, append additional
    let filteredCandidates = candidates;
    if (hasBadgeConfig) {
      if (badgeOpts.hidden?.length) {
        const hiddenSet = new Set<string>(badgeOpts.hidden);
        filteredCandidates = filteredCandidates.filter((b) => !hiddenSet.has(b.entity));
      }
      if (badgeOpts.additional?.length) {
        for (const entityId of badgeOpts.additional) {
          if (hass.states[entityId] && !filteredCandidates.some((b) => b.entity === entityId)) {
            filteredCandidates.push({ entity: entityId, color: getColorForEntity(entityId, hass) });
          }
        }
      }
    }

    // Resolve show_name per badge: default + config overrides
    const namesVisible = hasBadgeConfig ? new Set<string>(badgeOpts.names_visible || []) : null;
    const namesHidden = hasBadgeConfig ? new Set<string>(badgeOpts.names_hidden || []) : null;

    // Convert to LovelaceBadgeConfig
    const badges: LovelaceBadgeConfig[] = [];
    if (primaryTemp) badges.push({ type: 'entity', entity: primaryTemp, color: 'red', tap_action: { action: 'more-info' } });
    if (primaryHumidity) badges.push({ type: 'entity', entity: primaryHumidity, color: 'indigo', tap_action: { action: 'more-info' } });
    for (const b of filteredCandidates) {
      const showName = resolveShowName(b.entity, !!b.showName, namesVisible, namesHidden);
      badges.push({
        type: 'entity',
        entity: b.entity,
        color: b.color,
        tap_action: { action: 'more-info' },
        ...(showName ? { show_name: true } : {}),
      });
    }

    // === SECTIONS ===
    const sections: LovelaceSectionConfig[] = [
      ...buildAreaCustomCardSection(customCards, 'top'),
    ];
    const stacksOrder = mergeStacksOrder(dashboardConfig.areas_options?.[area.area_id]?.stacks_order);
    const stacks = new Map<StackKey, LovelaceSectionConfig[]>();

    function pushStack(key: StackKey, section: LovelaceSectionConfig): void {
      const items = stacks.get(key) ?? [];
      items.push(section);
      stacks.set(key, items);
    }

    const visibleUpsBatteries = new Set(roomEntities.ups);
    const visibleUpsDevices = upsDevices.filter((ups) => visibleUpsBatteries.has(ups.batteryId));

    if (visibleUpsDevices.length > 0) {
      const critThreshold = typeof dashboardConfig.battery_critical_threshold === 'number'
        ? dashboardConfig.battery_critical_threshold
        : 20;
      const lowThreshold = typeof dashboardConfig.battery_low_threshold === 'number'
        ? dashboardConfig.battery_low_threshold
        : 50;

      for (const ups of visibleUpsDevices) {
        const upsCards: LovelaceCardConfig[] = [
          {
            type: 'heading',
            heading: ups.name,
            heading_style: 'title',
            icon: 'mdi:power-plug-battery',
          },
          {
            type: 'gauge',
            entity: ups.batteryId,
            name: localize('ups.battery'),
            min: 0,
            max: 100,
            needle: false,
            severity: { red: 0, yellow: critThreshold, green: lowThreshold },
            tap_action: { action: 'more-info' },
          },
        ];

        for (const sensorId of ups.sensorIds) {
          upsCards.push({
            type: 'tile',
            entity: sensorId,
            name: stripAreaName(sensorId, area, hass),
            vertical: false,
            tap_action: { action: 'more-info' },
          });
        }

        pushStack('ups', { type: 'grid', cards: upsCards });
      }
    }

    // Cameras
    if (roomEntities.cameras.length > 0) {
      const cameraCards: LovelaceCardConfig[] = [];
      for (const cameraId of roomEntities.cameras) {
        if (!hass.states[cameraId]) continue;
        const camEntity = Registry.getEntity(cameraId);
        const deviceId = camEntity?.device_id;

        let isReolink = false;
        let isAqara = false;
        if (deviceId) {
          const device = Registry.getDevice(deviceId);
          if (device) {
            const mfr = (device.manufacturer || '').toLowerCase();
            const model = (device.model || '').toLowerCase();
            isReolink = mfr.includes('reolink') || model.includes('reolink');
            isAqara = mfr.includes('aqara') || model.includes('aqara');
          }
        }

        if ((isReolink || isAqara) && deviceId) {
          const devEntities = Registry.getEntityIdsForDevice(deviceId);

          // Reolink-specific entities
          const spotlight = devEntities.find(
            (id) => id.startsWith('light.') && hass.states[id] && !Registry.isEntityExcluded(id)
          );
          const motion = devEntities.find(
            (id) =>
              id.startsWith('binary_sensor.') &&
              hass.states[id]?.attributes?.device_class === 'motion' &&
              !Registry.isEntityExcluded(id)
          );
          const siren = devEntities.find(
            (id) => id.startsWith('siren.') && hass.states[id] && !Registry.isEntityExcluded(id)
          );

          // Aqara-specific entities
          const battery = devEntities.find(
            (id) =>
              id.startsWith('sensor.') &&
              hass.states[id]?.attributes?.device_class === 'battery' &&
              !Registry.isEntityExcluded(id)
          );
          const doorbell = devEntities.find(
            (id) =>
              id.startsWith('event.') &&
              hass.states[id]?.attributes?.device_class === 'doorbell' &&
              !Registry.isEntityExcluded(id)
          );

          const glanceEntities: any[] = [];
          if (isReolink) {
            if (spotlight) glanceEntities.push({ entity: spotlight });
            if (motion) glanceEntities.push({ entity: motion });
            if (siren) glanceEntities.push({ entity: siren });
          }
          if (isAqara) {
            if (battery) glanceEntities.push({ entity: battery });
            if (doorbell) glanceEntities.push({ entity: doorbell });
          }

          cameraCards.push({
            type: 'picture-glance',
            camera_image: cameraId,
            camera_view: isAqara ? 'live' : 'auto',
            fit_mode: 'cover',
            title: stripAreaName(cameraId, area, hass),
            entities: glanceEntities,
          });
        } else {
          cameraCards.push({
            type: 'picture-entity',
            entity: cameraId,
            camera_image: cameraId,
            camera_view: 'auto',
            name: stripAreaName(cameraId, area, hass),
            show_name: true,
            show_state: false,
          });
        }
      }
      if (cameraCards.length > 0) {
        pushStack('cameras', {
          type: 'grid',
          cards: [{ type: 'heading', heading: localize('room.cameras'), heading_style: 'title', icon: 'mdi:cctv' }, ...cameraCards],
        });
      }
    }

    // Sort lights by last_changed (unless custom order)
    if (!groupsOptions.lights?.order) {
      roomEntities.lights.sort((a, b) => sortByLastChanged(a, b, hass));
    }

    // Helper: create a domain section
    const domainSection = (
      key: StackKey,
      entities: string[],
      heading: string,
      icon: string,
      tileConfig: (e: string) => LovelaceCardConfig
    ): void => {
      if (entities.length === 0) return;
      pushStack(key, {
        type: 'grid',
        cards: [{ type: 'heading', heading, heading_style: 'title', icon }, ...entities.map(tileConfig)],
      });
    };

    if (roomEntities.lights.length > 0) {
      pushStack('lights', {
        type: 'grid',
        cards: [
          {
            type: 'custom:simon42-lights-group-card',
            entities: roomEntities.lights,
            group_type: 'all',
            heading_label: localize('room.lighting'),
            heading_icon: 'mdi:lightbulb',
            area,
            default_expanded: true,
            nested_groups: dashboardConfig.nested_light_groups === true,
          },
        ],
      });
    }

    domainSection('locks', roomEntities.locks, localize('room.locks'), 'mdi:lock', (e) => ({
      type: 'tile',
      entity: e,
      name: stripAreaName(e, area, hass),
      features: [{ type: 'lock-commands' }],
      features_position: 'inline',
      vertical: false,
      state_content: 'last_changed',
    }));

    domainSection('climate', roomEntities.climate, localize('room.climate'), 'mdi:thermostat', (e) => ({
      type: 'tile',
      entity: e,
      name: stripAreaName(e, area, hass),
      features: [{ type: 'climate-hvac-modes' }],
      features_position: 'inline',
      vertical: false,
      state_content: ['hvac_action', 'current_temperature'],
    }));

    domainSection('covers', roomEntities.covers, localize('room.covers'), 'mdi:window-shutter', (e) => ({
      type: 'tile',
      entity: e,
      name: stripAreaName(e, area, hass),
      features: [{ type: 'cover-open-close' }],
      vertical: false,
      features_position: 'inline',
      state_content: ['current_position', 'last_changed'],
    }));

    domainSection('covers_curtain', roomEntities.covers_curtain, localize('room.curtains'), 'mdi:curtains', (e) => ({
      type: 'tile',
      entity: e,
      name: stripAreaName(e, area, hass),
      features: [{ type: 'cover-open-close' }],
      vertical: false,
      features_position: 'inline',
      state_content: ['current_position', 'last_changed'],
    }));

    domainSection('covers_window', roomEntities.covers_window, localize('room.windows'), 'mdi:window-open-variant', (e) => ({
      type: 'tile',
      entity: e,
      name: stripAreaName(e, area, hass),
      features: [{ type: 'cover-open-close' }],
      vertical: false,
      features_position: 'inline',
      state_content: ['current_position', 'last_changed'],
    }));

    domainSection('media', roomEntities.media_player, localize('room.media'), 'mdi:speaker', (e) => {
      const state = hass.states[e];
      const hasPlayback = state && mediaPlayerSupportsPlayback(state);
      return {
        type: 'tile',
        entity: e,
        name: stripAreaName(e, area, hass),
        vertical: false,
        ...(hasPlayback ? { features: [{ type: 'media-player-playback' }], features_position: 'inline' } : {}),
        state_content: ['media_title', 'media_artist'],
      };
    });

    domainSection('scenes', roomEntities.scenes, localize('room.scenes'), 'mdi:palette', (e) => ({
      type: 'tile',
      entity: e,
      name: stripAreaName(e, area, hass),
      vertical: false,
      state_content: 'last_changed',
    }));

    // Misc (vacuum, fan, switches)
    const miscCards: LovelaceCardConfig[] = [];
    for (const e of roomEntities.vacuum)
      miscCards.push({
        type: 'tile',
        entity: e,
        name: stripAreaName(e, area, hass),
        features: [{ type: 'vacuum-commands' }],
        features_position: 'inline',
        vertical: false,
        state_content: 'last_changed',
      });
    for (const e of roomEntities.fan) {
      const state = hass.states[e];
      const hasSpeed = state && fanSupportsSpeed(state);
      miscCards.push({
        type: 'tile',
        entity: e,
        name: stripAreaName(e, area, hass),
        ...(hasSpeed ? { features: [{ type: 'fan-speed' }], features_position: 'inline' } : {}),
        vertical: false,
        state_content: 'last_changed',
      });
    }
    for (const e of roomEntities.switches)
      miscCards.push({
        type: 'tile',
        entity: e,
        name: stripAreaName(e, area, hass),
        vertical: false,
        state_content: 'last_changed',
      });

    miscCards.sort((a, b) => {
      const sA = hass.states[a.entity];
      const sB = hass.states[b.entity];
      if (!sA || !sB) return 0;
      return new Date(sB.last_changed).getTime() - new Date(sA.last_changed).getTime();
    });

    if (miscCards.length > 0) {
      pushStack('misc', {
        type: 'grid',
        cards: [
          { type: 'heading', heading: localize('room.misc'), heading_style: 'title', icon: 'mdi:dots-horizontal' },
          ...miscCards,
        ],
      });
    }

    domainSection('automations', roomEntities.automations, localize('room.automations'), 'mdi:robot', (e) => ({
      type: 'tile',
      entity: e,
      name: stripAreaName(e, area, hass),
      vertical: false,
      state_content: 'last_changed',
    }));

    domainSection('scripts', roomEntities.scripts, localize('room.scripts'), 'mdi:script-text', (e) => ({
      type: 'tile',
      entity: e,
      name: stripAreaName(e, area, hass),
      vertical: false,
    }));

    // Room Pins
    const roomPinEntities: string[] = dashboardConfig.room_pin_entities || [];
    const pinsForArea = roomPinEntities.filter((entityId) => {
      const entity = Registry.getEntity(entityId);
      if (!entity) return false;
      if (entity.area_id === area.area_id) return true;
      if (entity.device_id) {
        const device = Registry.getDevice(entity.device_id);
        if (device?.area_id === area.area_id) return true;
      }
      return false;
    });

    if (pinsForArea.length > 0) {
      pushStack('room_pins', {
        type: 'grid',
        cards: [
          { type: 'heading', heading: localize('room.room_pins'), heading_style: 'title', icon: 'mdi:pin' },
          ...pinsForArea.map((e) => {
            const pinStateContent: string[] = [];
            if (dashboardConfig.room_pins_show_state === true) pinStateContent.push('state');
            if (dashboardConfig.room_pins_hide_last_changed !== true) pinStateContent.push('last_changed');
            return {
              type: 'tile',
              entity: e,
              name: stripAreaName(e, area, hass),
              vertical: false,
              ...(pinStateContent.length > 0 ? { state_content: pinStateContent } : {}),
            };
          }),
        ],
      });
    }

    for (const key of stacksOrder) {
      const blocks = stacks.get(key);
      if (blocks) sections.push(...blocks);
    }
    sections.push(...buildAreaCustomCardSection(customCards, 'bottom'));

    debugLog(
      `Room ${area.area_id}: ${visibleEntities.length} visible entities, ${sections.length} sections, ${badges.length} badges`
    );
    timeEnd(`room-generate-${area.area_id}`);
    return { type: 'sections', header: { badges_position: 'bottom' }, sections, badges };
  }
}

customElements.define('ll-strategy-simon42-view-room', Simon42ViewRoomStrategy);
