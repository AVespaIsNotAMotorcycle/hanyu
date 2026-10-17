import { useLocalData } from './local/LocalData';

/** One line on whether this device's reviews have reached the server. */
export function SyncIndicator() {
  const { status, sync } = useLocalData();
  const waiting =
    status.unsynced > 0
      ? `${status.unsynced} ${status.unsynced === 1 ? 'review' : 'reviews'} saved on this device`
      : null;

  let text: string;
  switch (status.state) {
    case 'syncing':
      text = 'Syncing…';
      break;
    case 'offline':
      text = `Offline${waiting ? ` · ${waiting}, will sync when you’re back online` : ''}`;
      break;
    case 'error':
      text = `Sync problem: ${status.error}${waiting ? ` · ${waiting}` : ''}`;
      break;
    default:
      text = status.lastSyncedAt
        ? `Synced ${status.lastSyncedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
        : 'Not synced yet';
  }

  return (
    <p className={`status sync ${status.state}`} role="status">
      {text}
      {(status.state === 'offline' || status.state === 'error') && (
        <>
          {' '}
          <button
            type="button"
            className="link"
            onClick={() => void sync.sync()}
          >
            Retry
          </button>
        </>
      )}
    </p>
  );
}
