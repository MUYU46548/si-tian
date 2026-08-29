// E10: GeoJSON 导出/导入 — 对标 QGIS/ArcGIS 图层互操作
// 坐标系：司天世界坐标（米，局部平面系）。GeoJSON 标准是 WGS84 经纬度，
// 这里在 FeatureCollection 顶部写非标准 crs 成员声明局部米制坐标系（GDAL/QGIS 可识别），
// 并附 sitianMeta 供导入端校验。Polygon 环自动闭合（GeoJSON 要求首尾同点）。

let importSerial = 0;

function closeRing(points) {
  if (!points || points.length < 3) return points;
  const first = points[0];
  const last = points[points.length - 1];
  if (first.x === last.x && first.y === last.y) return points;
  return [...points, { x: first.x, y: first.y }];
}

function pointCoords(p) {
  return [p.x, p.y];
}

function ringCoords(points) {
  return closeRing(points).map(pointCoords);
}

// 导出：行星地图 → FeatureCollection
// data: { planet, places, terrain, regions, markers, routes, textLabels }
export function planetToGeoJSON(data) {
  const features = [];

  for (const place of data.places || []) {
    if (!place.coordinate || place.coordinate.x == null) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: pointCoords(place.coordinate) },
      properties: {
        kind: 'place',
        id: place.id,
        name: place.displayName || place.name,
        layer: place.layer,
        tags: [...(place.tags || [])],
        parentId: place.parentId,
        draft: !!place.draft,
        userMoved: !!place.userMoved,
      },
    });
  }

  for (const poly of data.terrain || []) {
    if (!poly.points || poly.points.length < 3) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [ringCoords(poly.points)] },
      properties: { kind: 'terrain', id: poly.id, name: poly.name || null, type: poly.type || null },
    });
  }

  for (const region of data.regions || []) {
    if (!region.points || region.points.length < 3) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [ringCoords(region.points)] },
      properties: { kind: 'region', id: region.id, name: region.name || null, color: region.color || null },
    });
  }

  for (const route of data.routes || []) {
    if (!route.points || route.points.length < 2) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: route.points.map(pointCoords) },
      properties: { kind: 'route', id: route.id, name: route.name || null, color: route.color || null },
    });
  }

  for (const marker of data.markers || []) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: pointCoords({ x: marker.x, y: marker.y }) },
      properties: { kind: 'marker', id: marker.id, type: marker.type || null, icon: marker.icon || null, color: marker.color || null, note: marker.note || null },
    });
  }

  for (const label of data.textLabels || []) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: pointCoords({ x: label.x, y: label.y }) },
      properties: { kind: 'textLabel', id: label.id, text: label.text || null, fontSize: label.fontSize || null, color: label.color || null },
    });
  }

  return {
    type: 'FeatureCollection',
    crs: { type: 'name', properties: { name: 'urn:sitian:crs:local-meter' } },
    sitianMeta: {
      exporter: 'SiTian',
      version: 1,
      planetId: data.planet?.id || null,
      planetName: data.planet?.displayName || data.planet?.name || null,
      units: 'meter',
      exportedAt: new Date().toISOString(),
    },
    features,
  };
}

// 导入：FeatureCollection → 可回填对象列表（全部带 draft 性质，不覆盖 Obsidian 节点）
// 返回 { places, markers, textLabels, routes, regions, skipped, errors }
export function geoJSONToPlanet(fc) {
  const result = { places: [], markers: [], textLabels: [], routes: [], regions: [], skipped: 0, errors: [] };
  if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    result.errors.push('不是有效的 GeoJSON FeatureCollection');
    return result;
  }

  for (const feature of fc.features) {
    const props = feature.properties || {};
    const geom = feature.geometry;
    importSerial += 1;
    const newId = `geojson_${importSerial}`;

    try {
      if (!geom) { result.skipped += 1; continue; }

      if (geom.type === 'Point' && props.kind === 'place') {
        const [x, y] = geom.coordinates;
        result.places.push({
          id: newId,
          name: props.name || `导入地点 ${importSerial}`,
          layer: ['city', 'town', 'village', 'location'].includes(props.layer) ? props.layer : 'location',
          layerLabel: '',
          parentId: null, // 由导入方归属当前行星
          tags: Array.isArray(props.tags) ? props.tags : [],
          sourcePath: '',
          coordinate: { x, y },
          draft: true, // 无 Obsidian 词条，虚线标记
        });
      } else if (geom.type === 'Point' && props.kind === 'marker') {
        const [x, y] = geom.coordinates;
        result.markers.push({ id: newId, type: props.type || 'pin', x, y, icon: props.icon || '📍', color: props.color || null, note: props.note || '' });
      } else if (geom.type === 'Point' && props.kind === 'textLabel') {
        const [x, y] = geom.coordinates;
        result.textLabels.push({ id: newId, text: props.text || '', x, y, fontSize: props.fontSize || 14, color: props.color || '#cccccc' });
      } else if (geom.type === 'LineString' && props.kind === 'route') {
        result.routes.push({ id: newId, name: props.name || null, color: props.color || null, points: geom.coordinates.map(([x, y]) => ({ x, y })) });
      } else if (geom.type === 'Polygon' && props.kind === 'region') {
        // 只取外环；司天区域为单环多边形
        result.regions.push({
          id: newId,
          name: props.name || null,
          color: props.color || null,
          points: (geom.coordinates[0] || []).map(([x, y]) => ({ x, y })),
        });
      } else {
        // terrain 等其他类型跳过（不覆盖原始地形数据）
        result.skipped += 1;
      }
    } catch (e) {
      result.errors.push(`Feature ${props.id || importSerial}: ${e.message}`);
    }
  }
  return result;
}
