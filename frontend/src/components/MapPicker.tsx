import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef } from 'react';

export interface LatLng {
  lat: number;
  lng: number;
}

const DEFAULT_CENTER: LatLng = { lat: 10.8231, lng: 106.6297 }; // TP.HCM

/**
 * Ghim tọa độ trên bản đồ OpenStreetMap (QĐ-21): bấm vào bản đồ để đặt vị trí.
 * radiusKm: vẽ vòng tròn bán kính phục vụ (chi nhánh).
 */
export function MapPicker({ value, onChange, radiusKm }: { value?: LatLng; onChange: (p: LatLng) => void; radiusKm?: number }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map>();
  const marker = useRef<L.CircleMarker>();
  const circle = useRef<L.Circle>();
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current).setView(value ?? DEFAULT_CENTER, value ? 15 : 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(m);
    m.on('click', (e: L.LeafletMouseEvent) => onChangeRef.current({ lat: +e.latlng.lat.toFixed(6), lng: +e.latlng.lng.toFixed(6) }));
    map.current = m;
    return () => {
      m.remove();
      map.current = undefined;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    marker.current?.remove();
    circle.current?.remove();
    if (!value) return;
    marker.current = L.circleMarker(value, { radius: 8, color: '#1f7a4d', fillOpacity: 0.9 }).addTo(m);
    if (radiusKm) circle.current = L.circle(value, { radius: radiusKm * 1000, color: '#1f7a4d', weight: 1, fillOpacity: 0.08 }).addTo(m);
  }, [value?.lat, value?.lng, radiusKm]); // eslint-disable-line react-hooks/exhaustive-deps

  const useMyLocation = () =>
    navigator.geolocation?.getCurrentPosition((pos) => {
      const p = { lat: +pos.coords.latitude.toFixed(6), lng: +pos.coords.longitude.toFixed(6) };
      onChangeRef.current(p);
      map.current?.setView(p, 15);
    });

  return (
    <div className="stack">
      <div ref={el} className="map" />
      <div className="row">
        <button type="button" className="secondary" onClick={useMyLocation}>
          Dùng vị trí hiện tại
        </button>
        <span className="muted">{value ? `${value.lat}, ${value.lng}` : 'Bấm vào bản đồ để ghim vị trí'}</span>
      </div>
    </div>
  );
}
