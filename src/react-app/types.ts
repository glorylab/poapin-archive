export interface ArchiveCounts {
  drops: number;
  tokens: number;
  owners: number;
  artworks: number;
}

export interface ArchiveMeta {
  snapshotId: string;
  snapshotAt: string;
  counts: ArchiveCounts;
  years: number[];
}

export interface Drop {
  dropId: number;
  fancyId?: string | null;
  title: string;
  description?: string | null;
  startDate: string;
  endDate?: string | null;
  city?: string | null;
  country?: string | null;
  year: number;
  isVirtual?: boolean | null;
  eventUrl?: string | null;
  channel?: string | null;
  platform?: string | null;
  locationType?: string | null;
  timezone?: string | null;
  createdAt?: string | null;
  imageUrl: string;
  hasArtwork?: boolean;
  tokenCount?: number;
  reservationsTotal?: number;
  reservationsMinted?: number;
  reservationsUnminted?: number;
}

export interface Holding extends Drop {
  sourceUid: string;
  poapId: number;
  mintedOn?: number | null;
  ownerAddress: string;
  network: string;
  transferCount: number;
}

export interface PageResponse<T> {
  items: T[];
  nextCursor: string | null;
}

export interface OwnerPageResponse extends PageResponse<Holding> {
  address: string;
  total: number;
}

export type DropSort = "recent" | "oldest" | "popular";
export type EventType = "all" | "virtual" | "in-person";
