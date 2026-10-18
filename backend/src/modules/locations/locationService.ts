import type { Clock } from '../../shared/clock';
import { conflict, notFound } from '../../shared/errors';
import { newId } from '../../shared/ids';
import { bool, geoPoint, str, type GeoPoint } from '../../shared/validate';
import { keys } from '../../store/keys';
import { withOptimisticRetry } from '../../store/retry';
import { putVersioned, type Item, type Table, type WriteOp } from '../../store/table';

export interface SavedLocation extends Item {
  locationId: string;
  userId: string;
  name: string;
  location: GeoPoint;
  /** Khu vực hiển thị cho đối tác (phường/quận). */
  area: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

const MAX_LOCATIONS = 10;

/** Địa điểm đã lưu (T2.1). Đúng 1 địa điểm mặc định khi có ít nhất 1 địa điểm. */
export class LocationService {
  constructor(
    private readonly table: Table,
    private readonly clock: Clock,
  ) {}

  list(userId: string) {
    return this.table.query<SavedLocation>(keys.userPk(userId), { skPrefix: 'LOC#' });
  }

  async create(userId: string, input: Record<string, unknown>): Promise<SavedLocation> {
    const existing = await this.list(userId);
    if (existing.length >= MAX_LOCATIONS) throw conflict('LOCATION_LIMIT', `Tối đa ${MAX_LOCATIONS} địa điểm`);
    const now = this.clock.now().toISOString();
    const locationId = newId();
    const makeDefault = existing.length === 0 || input.isDefault === true;
    const loc: SavedLocation = {
      ...keys.savedLocation(userId, locationId),
      locationId,
      userId,
      name: str(input.name, 'name', { min: 1, max: 60 }),
      location: geoPoint(input.location),
      area: str(input.area, 'area', { min: 2, max: 120 }),
      isDefault: makeDefault,
      createdAt: now,
      updatedAt: now,
    };
    await this.table.transact([putVersioned(loc, 0), ...(makeDefault ? this.unsetDefaults(existing, now) : [])]);
    return { ...loc, version: 1 };
  }

  update(userId: string, locationId: string, input: Record<string, unknown>): Promise<SavedLocation> {
    return withOptimisticRetry(async () => {
      const all = await this.list(userId);
      const current = all.find((l) => l.locationId === locationId);
      if (!current) throw notFound('địa điểm');
      const now = this.clock.now().toISOString();
      const next: SavedLocation = { ...current, updatedAt: now };
      if (input.name !== undefined) next.name = str(input.name, 'name', { min: 1, max: 60 });
      if (input.location !== undefined) next.location = geoPoint(input.location);
      if (input.area !== undefined) next.area = str(input.area, 'area', { min: 2, max: 120 });
      const makeDefault = input.isDefault !== undefined && bool(input.isDefault, 'isDefault');
      if (makeDefault) next.isDefault = true;
      const others = makeDefault ? this.unsetDefaults(all.filter((l) => l.locationId !== locationId), now) : [];
      await this.table.transact([putVersioned(next, current.version ?? 1), ...others]);
      return { ...next, version: (current.version ?? 1) + 1 };
    });
  }

  /** Xóa; nếu xóa địa điểm mặc định thì địa điểm còn lại cũ nhất thành mặc định. */
  remove(userId: string, locationId: string) {
    return withOptimisticRetry(async () => {
      const all = await this.list(userId);
      const current = all.find((l) => l.locationId === locationId);
      if (!current) throw notFound('địa điểm');
      const ops: WriteOp[] = [{ type: 'delete', pk: current.pk, sk: current.sk }];
      const rest = all.filter((l) => l.locationId !== locationId);
      if (current.isDefault && rest[0]) ops.push(putVersioned({ ...rest[0], isDefault: true }, rest[0].version ?? 1));
      await this.table.transact(ops);
      return { deleted: locationId };
    });
  }

  private unsetDefaults(locs: SavedLocation[], now: string): WriteOp[] {
    return locs.filter((l) => l.isDefault).map((l) => putVersioned({ ...l, isDefault: false, updatedAt: now }, l.version ?? 1));
  }
}
