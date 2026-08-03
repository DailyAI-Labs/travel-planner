import React, { useEffect, useMemo } from 'react';
import { MapContainer, Marker, Polyline, Popup, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useI18n } from '../i18n';

// Distinct hues so overlapping days stay readable; reused cyclically beyond.
export const DAY_COLOURS = [
  '#2f6f4f',
  '#2b6cb0',
  '#a8630a',
  '#7b3fa0',
  '#0f7d8c',
  '#a33b6a',
];

export function dayColour(dayIndex) {
  return DAY_COLOURS[dayIndex % DAY_COLOURS.length];
}

/**
 * Leaflet's default marker images break under bundlers, and a plain pin would
 * not convey visit order anyway, so each stop is drawn as its own numbered
 * badge, tinted by the day it belongs to.
 */
function stopIcon(position, colour) {
  return L.divIcon({
    className: 'map-marker-wrapper',
    html: `<div class="map-marker" style="background:${colour}">${position}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    popupAnchor: [0, -16],
  });
}

function FitToRoute({ positions }) {
  const map = useMap();

  useEffect(() => {
    if (positions.length === 0) return;
    if (positions.length === 1) {
      map.setView(positions[0], 15);
      return;
    }
    map.fitBounds(positions, { padding: [45, 45] });
  }, [map, positions]);

  return null;
}

/** A day whose last stop repeats its first is a loop. */
function isLoop(waypoints) {
  if (waypoints.length < 2) return false;
  const first = waypoints[0];
  const last = waypoints[waypoints.length - 1];
  return first.lat === last.lat && first.lon === last.lon;
}

function RouteMap({ days }) {
  const { t } = useI18n();

  const allPositions = useMemo(
    () =>
      days.flatMap((day) =>
        day.waypoints.map((point) => [point.lat, point.lon])
      ),
    [days]
  );

  if (allPositions.length === 0) return null;

  return (
    <div className="map-panel">
      <MapContainer
        center={allPositions[0]}
        zoom={13}
        scrollWheelZoom
        className="map-canvas"
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          maxZoom={19}
        />

        {days.map((day, dayIndex) => {
          const positions = day.waypoints.map((p) => [p.lat, p.lon]);
          const colour = dayColour(dayIndex);
          const loop = isLoop(day.waypoints);
          // Drawing the repeated final stop would stack two badges on one
          // point, hiding the "1" under the last number.
          const markers = loop ? day.waypoints.slice(0, -1) : day.waypoints;

          return (
            <React.Fragment key={day.day}>
              {positions.slice(0, -1).map((from, legIndex) => {
                const leg = day.route_details[legIndex];
                return (
                  <Polyline
                    key={`d${day.day}-l${legIndex}`}
                    positions={[from, positions[legIndex + 1]]}
                    pathOptions={{
                      color: leg?.requires_vehicle ? '#d9534f' : colour,
                      weight: 4,
                      opacity: 0.85,
                      dashArray: leg?.requires_vehicle ? '8 8' : undefined,
                    }}
                  />
                );
              })}

              {markers.map((point, index) => (
                <Marker
                  key={`d${day.day}-m${index}`}
                  position={positions[index]}
                  icon={stopIcon(index + 1, colour)}
                >
                  <Popup>
                    <strong>
                      {days.length > 1 && `${t('results.day', { day: day.day })} · `}
                      {index + 1}. {point.name}
                    </strong>
                    {loop && index === 0 && <> — {t('map.startFinish')}</>}
                    <br />
                    {point.lat.toFixed(5)}, {point.lon.toFixed(5)}
                  </Popup>
                </Marker>
              ))}
            </React.Fragment>
          );
        })}

        <FitToRoute positions={allPositions} />
      </MapContainer>

      {days.length > 1 && (
        <ul className="map-legend">
          {days.map((day, dayIndex) => (
            <li key={day.day}>
              <span
                className="legend-swatch"
                style={{ background: dayColour(dayIndex) }}
              />
              {t('results.day', { day: day.day })}
            </li>
          ))}
        </ul>
      )}

      <p className="map-caption">{t('map.caption')}</p>
    </div>
  );
}

export default RouteMap;
