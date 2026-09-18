import { useEffect, useMemo, useState, type FormEvent } from "react";
import "./App.css";

type ListName = "whitelist" | "blacklist" | "graylist";

type Entry = {
  id: number;
  list: ListName;
  cidr: string;
  createdAt: string;
  expiresAt: string | null;
  reason: string | null;
  graylistInsertions: number;
  graylistInsertionsInWindow: number;
};

type AuditEvent = {
  id: number;
  cidr: string;
  event: string;
  reason: string | null;
  created_at: string;
};

type ApiError = {
  error?: string;
  conflict?: Entry;
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const data = (await res.json().catch(() => ({}))) as T & ApiError;
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function toDatetimeLocal(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function defaultExpiryLocal() {
  return toDatetimeLocal(new Date(Date.now() + 5 * 24 * 60 * 60 * 1000));
}

function formatTimestamp(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function reasonLabel(reason: string | null) {
  if (reason === "graylist_threshold_reached") return "Promoted: 3 graylist events in 20 days";
  if (reason === "blacklist_expired") return "Blacklist expired";
  if (reason === "manual_move") return "Manual move";
  if (reason === "manual") return "Manual";
  return reason;
}

export default function App() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [cidr, setCidr] = useState("");
  const [noExpiration, setNoExpiration] = useState(false);
  const [expiresLocal, setExpiresLocal] = useState(defaultExpiryLocal);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState<Entry | null>(null);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);

  const filteredEntries = useMemo(() => {
    if (!search.trim()) return entries;
    const s = search.toLowerCase();
    return entries.filter((e) => e.cidr.toLowerCase().includes(s));
  }, [entries, search]);

  const whitelist = useMemo(() => filteredEntries.filter((e) => e.list === "whitelist"), [filteredEntries]);
  const blacklist = useMemo(() => filteredEntries.filter((e) => e.list === "blacklist"), [filteredEntries]);
  const graylist = useMemo(() => filteredEntries.filter((e) => e.list === "graylist"), [filteredEntries]);

  async function refresh() {
    const data = await api<{ entries: Entry[] }>("/api/entries");
    setEntries(data.entries);
  }

  useEffect(() => {
    refresh().catch((err: Error) => setError(err.message));
    const timer = setInterval(() => {
      refresh().catch(() => {});
    }, 15000);
    return () => clearInterval(timer);
  }, []);

  async function addTo(list: ListName, event?: FormEvent) {
    event?.preventDefault();
    setError("");
    setConflict(null);
    setBusy(true);
    try {
      const body: Record<string, unknown> = { list, cidr };
      if (list === "blacklist") {
        if (noExpiration) body.permanent = true;
        else body.expiresAt = new Date(expiresLocal).toISOString();
      }
      await api("/api/entries", { method: "POST", body: JSON.stringify(body) });
      setCidr("");
      setNoExpiration(false);
      setExpiresLocal(defaultExpiryLocal());
      await refresh();
    } catch (err) {
      if (err instanceof Error) {
        setError(err.message);
        // If the error message came from our API and it's a conflict,
        // it might be attached to the error if we modified the `api` function
        // but let's try to fetch it from the message or a dedicated state
      } else {
        setError("Could not add address");
      }
    } finally {
      setBusy(false);
    }
  }

  // Modified api function to expose conflict data
  async function apiWithConflict<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
    const data = (await res.json().catch(() => ({}))) as T & ApiError;
    if (!res.ok) {
      if (data.conflict) setConflict(data.conflict);
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data;
  }

  // We need to update our calls to use the new api function that handles conflicts
  async function addToWithConflict(list: ListName, event?: FormEvent) {
    event?.preventDefault();
    setError("");
    setConflict(null);
    setBusy(true);
    try {
      const body: Record<string, unknown> = { list, cidr };
      if (list === "blacklist") {
        if (noExpiration) body.permanent = true;
        else body.expiresAt = new Date(expiresLocal).toISOString();
      }
      await apiWithConflict("/api/entries", { method: "POST", body: JSON.stringify(body) });
      setCidr("");
      setNoExpiration(false);
      setExpiresLocal(defaultExpiryLocal());
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add address");
    } finally {
      setBusy(false);
    }
  }


  async function remove(id: number) {
    setError("");
    setBusy(true);
    try {
      await api(`/api/entries/${id}`, { method: "DELETE" });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete");
    } finally {
      setBusy(false);
    }
  }

  async function move(id: number, target: ListName) {
    setError("");
    setBusy(true);
    try {
      await api(`/api/entries/${id}/move`, {
        method: "POST",
        body: JSON.stringify({ target }),
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not move");
    } finally {
      setBusy(false);
    }
  }

  async function saveExpiration(id: number, permanent: boolean, localValue: string) {
    setError("");
    setBusy(true);
    try {
      await api(`/api/entries/${id}`, {
        method: "PATCH",
        body: JSON.stringify(
          permanent ? { permanent: true } : { expiresAt: new Date(localValue).toISOString() },
        ),
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update expiration");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <header className="header">
        <h1>IP allow / deny lists</h1>
        <p className="lede">
          Whitelist, blacklist with optional expiration, and graylist. Expired
          blacklist addresses move to graylist automatically; three graylist
          events in 20 days promote an address to a permanent blacklist.
        </p>
      </header>

      <nav className="nav">
        <a href="#whitelist">Whitelist</a>
        <a href="#blacklist">Blacklist</a>
        <a href="#graylist">Graylist</a>
      </nav>

      <form className="composer" onSubmit={(event) => addTo("whitelist", event)}>
        <input
          value={cidr}
          onChange={(event) => setCidr(event.target.value)}
          placeholder="10.0.0.1 or 10.0.0.0/8"
          aria-label="IPv4 address or CIDR"
          autoComplete="off"
        />
        <label className="expire-toggle">
          <input
            type="checkbox"
            checked={noExpiration}
            onChange={(event) => setNoExpiration(event.target.checked)}
          />
          No expiration
        </label>
        <input
          type="datetime-local"
          value={expiresLocal}
          disabled={noExpiration}
          onChange={(event) => setExpiresLocal(event.target.value)}
          aria-label="Blacklist expiration date"
        />
        <button className="allow" type="submit" disabled={busy}>
          Add to whitelist
        </button>
        <button className="deny" type="button" disabled={busy} onClick={() => addToWithConflict("blacklist")}>
          Add to blacklist
        </button>
        <button className="watch" type="button" disabled={busy} onClick={() => addToWithConflict("graylist")}>
          Add to graylist
        </button>
      </form>

      <p className="hint">
        Blacklist expiration defaults to 5 days (UTC). Change the date to pick
        another expiry, or check “No expiration” for a permanent blacklist
        entry.
      </p>

      {conflict && (
        <div className="conflict-notice">
          <strong>Conflict Detected:</strong> {error}
          <br />
          The overlapping entry is currently in the <strong>{conflict.list}</strong>.
        </div>
      )}

      {!conflict && error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="search-bar">
        <input
          type="text"
          placeholder="Filter entries by IP or CIDR..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <section className="grid">
        <ListColumn
          id="whitelist"
          title="Whitelist"
          list="whitelist"
          entries={whitelist}
          busy={busy}
          onMove={move}
          onRemove={remove}
        />
        <ListColumn
          id="blacklist"
          title="Blacklist"
          list="blacklist"
          entries={blacklist}
          busy={busy}
          onMove={move}
          onRemove={remove}
          onSaveExpiration={saveExpiration}
        />
        <ListColumn
          id="graylist"
          title="Graylist"
          list="graylist"
          entries={graylist}
          busy={busy}
          onMove={move}
          onRemove={remove}
        />
      </section>
    </main>
  );
}

function ListColumn({
  id,
  title,
  list,
  entries,
  busy,
  onMove,
  onRemove,
  onSaveExpiration,
}: {
  id: string;
  title: string;
  list: ListName;
  entries: Entry[];
  busy: boolean;
  onMove: (id: number, target: ListName) => void;
  onRemove: (id: number) => void;
  onSaveExpiration?: (id: number, permanent: boolean, localValue: string) => void;
}) {
  const targets = (["whitelist", "blacklist", "graylist"] as ListName[]).filter((name) => name !== list);
  return (
    <section className={`column ${list}`} id={id}>
      <div className="column-head">
        <h2>{title}</h2>
        <span className="count">{entries.length} entries</span>
      </div>
      {entries.length === 0 ? (
        <p className="empty">No addresses yet.</p>
      ) : (
        entries.map((entry) => (
          <EntryRow
            key={`${entry.id}-${entry.expiresAt ?? "permanent"}`}
            entry={entry}
            busy={busy}
            targets={targets}
            onMove={onMove}
            onRemove={onRemove}
            onSaveExpiration={onSaveExpiration}
          />
        ))
      )}
    </section>
  );
}

function EntryRow({
  entry,
  busy,
  targets,
  onMove,
  onRemove,
  onSaveExpiration,
}: {
  entry: Entry;
  busy: boolean;
  targets: ListName[];
  onMove: (id: number, target: ListName) => void;
  onRemove: (id: number) => void;
  onSaveExpiration?: (id: number, permanent: boolean, localValue: string) => void;
}) {
  const [permanent, setPermanent] = useState(!entry.expiresAt);
  const [localValue, setLocalValue] = useState(() =>
    entry.expiresAt ? toDatetimeLocal(new Date(entry.expiresAt)) : defaultExpiryLocal(),
  );
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [showAudit, setShowAudit] = useState(false);

  useEffect(() => {
    if (showAudit && auditEvents.length === 0) {
      api<{ events: AuditEvent[] }>(`/api/audit/${encodeURIComponent(entry.cidr)}`)
        .then((data) => setAuditEvents(data.events))
        .catch(console.error);
    }
  }, [showAudit, entry.cidr, auditEvents.length]);

  return (
    <div className="row">
      <div className="row-main">
        <code className="cidr">{entry.cidr}</code>
        {entry.list === "blacklist" ? (
          entry.expiresAt ? (
            <span className="meta">Expires {formatTimestamp(entry.expiresAt)}</span>
          ) : (
            <span className="badge permanent">Permanent</span>
          )
        ) : null}
        {entry.list === "graylist" ? (
          <span className="meta">
            Entered {formatTimestamp(entry.createdAt)} · {entry.graylistInsertions} insertion
            {entry.graylistInsertions === 1 ? "" : "s"} · {entry.graylistInsertionsInWindow} in last 20 days
          </span>
        ) : null}
        {entry.reason ? <span className="meta">{reasonLabel(entry.reason)}</span> : null}
        {entry.reason === "graylist_threshold_reached" ? (
          <span className="badge promoted">Auto-promoted from graylist</span>
        ) : null}
      </div>
      {entry.list === "blacklist" && onSaveExpiration ? (
        <div className="expire-edit">
          <label className="expire-toggle">
            <input
              type="checkbox"
              checked={permanent}
              onChange={(event) => setPermanent(event.target.checked)}
            />
            No expiration
          </label>
          <input
            type="datetime-local"
            value={localValue}
            disabled={permanent || busy}
            onChange={(event) => setLocalValue(event.target.value)}
            aria-label={`Expiration for ${entry.cidr}`}
          />
          <button
            className="ghost"
            type="button"
            disabled={busy}
            onClick={() => onSaveExpiration(entry.id, permanent, localValue)}
          >
            Save expiration
          </button>
        </div>
      ) : null}

      <details className="audit-log" open={showAudit} onToggle={(e) => setShowAudit((e.target as HTMLDetailsElement).open)}>
        <summary>View Activity Log</summary>
        <table className="audit-table">
          <thead>
            <tr>
              <th>Event</th>
              <th>Reason</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>
            {auditEvents.length === 0 ? (
              <tr><td colSpan={3}>Loading or no events...</td></tr>
            ) : (
              auditEvents.map(event => (
                <tr key={event.id}>
                  <td>{event.event.replace(/_/g, ' ')}</td>
                  <td>{reasonLabel(event.reason)}</td>
                  <td>{formatTimestamp(event.created_at)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </details>

      <div className="row-actions">
        {targets.map((target) => (
          <button
            key={target}
            className="ghost"
            type="button"
            disabled={busy}
            onClick={() => onMove(entry.id, target)}
          >
            Move to {target}
          </button>
        ))}
        <button className="ghost" type="button" disabled={busy} onClick={() => onRemove(entry.id)}>
          Remove
        </button>
      </div>
    </div>
  );
}
