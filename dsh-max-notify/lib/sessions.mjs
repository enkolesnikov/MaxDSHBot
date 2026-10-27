/**
 * Session list helpers: hide archived sessions from grouping surfaces.
 *
 * DSH keeps a registry-global archive set (`workspaceRegistry.archivedSessionIds`)
 * for sessions the user hid in the Workspace sidebar. Such sessions are inactive
 * for the user's workflow and must not appear in `/sessions`, `/use` or the
 * digest, even though the session store still lists them.
 */

/** Remove sessions present in the archive set (ids compared as strings). */
export function filterArchivedSessions(items, archivedIds) {
  const archived = new Set((Array.isArray(archivedIds) ? archivedIds : []).map((id) => String(id)))
  if (archived.size === 0) return Array.isArray(items) ? [...items] : []
  return (Array.isArray(items) ? items : []).filter((item) => !archived.has(String(item?.sessionId ?? '')))
}

/** Read the archive set from a workspace registry, tolerating an absent service. */
export function archivedIdsOf(registry) {
  try {
    const ids = registry?.archivedSessionIds
    return Array.isArray(ids) ? ids : []
  } catch {
    return []
  }
}
