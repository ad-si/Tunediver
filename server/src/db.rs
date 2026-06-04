// SQLite caching layer.
//
// The cache holds everything *except* the raw audio bytes: per-track tag
// metadata (artist, title, lyrics, DATE_ADDED), embedded cover art, and the
// user's playlists. Requests serve from here so the (potentially slow) audio
// files are only ever touched to stream audio. A background scan keeps the
// `tracks` table in sync, re-reading tags only for files whose mtime/size
// changed.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{params, OptionalExtension};

pub type Pool = r2d2::Pool<SqliteConnectionManager>;
pub type Conn = r2d2::PooledConnection<SqliteConnectionManager>;

// Cover art as cached for a track: (has_cover, bytes, mime). `has_cover ==
// false` is a cached negative result, so missing art is never re-probed.
pub type CachedCover = (bool, Option<Vec<u8>>, Option<String>);

// Everything cached for a single track. `path` is the canonicalization-free
// on-disk path used both as the primary key and to locate the file for
// streaming. `mtime`/`size` drive incremental rescans.
pub struct CachedTrack {
  pub path: String,
  pub mtime: i64,
  pub size: i64,
  pub artist: String,
  pub title: String,
  pub lyrics: Option<String>,
  pub date_added: Option<String>,
  pub has_cover: bool,
  pub cover_blob: Option<Vec<u8>>,
  pub cover_mime: Option<String>,
}

const SCHEMA_VERSION: i64 = 1;

// Open (creating if needed) a pooled connection to the cache database. WAL
// mode lets readers (cover/detail endpoints) proceed while the background
// scan writes. `foreign_keys` is per-connection, so it's set on every checkout
// via `with_init` — required for the playlist ON DELETE CASCADE to fire.
pub fn open_pool(db_path: &Path) -> Result<Pool, Box<dyn std::error::Error>> {
  let manager = SqliteConnectionManager::file(db_path).with_init(|c| {
    c.execute_batch(
      "PRAGMA journal_mode=WAL;\
       PRAGMA synchronous=NORMAL;\
       PRAGMA foreign_keys=ON;\
       PRAGMA busy_timeout=5000;",
    )
  });
  let pool = r2d2::Pool::new(manager)?;
  init_schema(&pool.get()?)?;
  Ok(pool)
}

fn init_schema(conn: &Conn) -> rusqlite::Result<()> {
  conn.execute_batch(
    "CREATE TABLE IF NOT EXISTS tracks (
       path       TEXT PRIMARY KEY,
       mtime      INTEGER NOT NULL,
       size       INTEGER NOT NULL,
       artist     TEXT NOT NULL,
       title      TEXT NOT NULL,
       lyrics     TEXT,
       date_added TEXT,
       has_cover  INTEGER NOT NULL DEFAULT 0,
       cover_blob BLOB,
       cover_mime TEXT
     );
     CREATE TABLE IF NOT EXISTS playlists (
       id         TEXT PRIMARY KEY,
       name       TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL,
       position   INTEGER NOT NULL
     );
     CREATE TABLE IF NOT EXISTS playlist_tracks (
       playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
       position    INTEGER NOT NULL,
       artist      TEXT NOT NULL,
       title       TEXT NOT NULL,
       PRIMARY KEY (playlist_id, position)
     );
     CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);",
  )?;
  conn.execute(
    "INSERT INTO meta (key, value) VALUES ('schema_version', ?1)
     ON CONFLICT(key) DO NOTHING",
    params![SCHEMA_VERSION.to_string()],
  )?;
  Ok(())
}

// Track cache -----------------------------------------------------------------

// Path -> (mtime, size) for every cached track, used by the scan to decide
// which files changed.
pub fn load_track_stamps(
  conn: &Conn,
) -> rusqlite::Result<HashMap<String, (i64, i64)>> {
  let mut stmt = conn.prepare("SELECT path, mtime, size FROM tracks")?;
  let rows = stmt.query_map([], |r| {
    Ok((
      r.get::<_, String>(0)?,
      (r.get::<_, i64>(1)?, r.get::<_, i64>(2)?),
    ))
  })?;
  let mut map = HashMap::new();
  for row in rows {
    let (path, stamp) = row?;
    map.insert(path, stamp);
  }
  Ok(map)
}

pub fn upsert_track(conn: &Conn, t: &CachedTrack) -> rusqlite::Result<()> {
  conn.execute(
    "INSERT INTO tracks
       (path, mtime, size, artist, title, lyrics, date_added, has_cover, cover_blob, cover_mime)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
     ON CONFLICT(path) DO UPDATE SET
       mtime=excluded.mtime, size=excluded.size, artist=excluded.artist,
       title=excluded.title, lyrics=excluded.lyrics, date_added=excluded.date_added,
       has_cover=excluded.has_cover, cover_blob=excluded.cover_blob,
       cover_mime=excluded.cover_mime",
    params![
      t.path,
      t.mtime,
      t.size,
      t.artist,
      t.title,
      t.lyrics,
      t.date_added,
      t.has_cover as i64,
      t.cover_blob,
      t.cover_mime,
    ],
  )?;
  Ok(())
}

pub fn delete_track(conn: &Conn, path: &str) -> rusqlite::Result<()> {
  conn.execute("DELETE FROM tracks WHERE path = ?1", params![path])?;
  Ok(())
}

// Build the in-memory catalog projection. Ordered by path so IDs (the row
// index) stay deterministic across restarts, matching the previous
// `build_catalog` behavior.
pub fn load_catalog(conn: &Conn) -> rusqlite::Result<crate::Catalog> {
  let mut stmt =
    conn.prepare("SELECT artist, title, path FROM tracks ORDER BY path")?;
  let rows = stmt.query_map([], |r| {
    Ok((
      r.get::<_, String>(0)?,
      r.get::<_, String>(1)?,
      r.get::<_, String>(2)?,
    ))
  })?;
  let mut tracks = Vec::new();
  for (id, row) in rows.enumerate() {
    let (artist, title, path) = row?;
    tracks.push(crate::Track {
      id,
      artist,
      title,
      path: PathBuf::from(path),
    });
  }
  Ok(crate::Catalog { tracks })
}

// Lyrics + DATE_ADDED for the song-detail endpoint. Returns None if the track
// has not been cached yet (e.g. an in-flight initial scan).
pub fn get_track_detail(
  conn: &Conn,
  path: &str,
) -> rusqlite::Result<Option<(Option<String>, Option<String>)>> {
  conn
    .query_row(
      "SELECT lyrics, date_added FROM tracks WHERE path = ?1",
      params![path],
      |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
}

// Cover art for the cover endpoint. Returns None if the track has not been
// cached yet (distinct from a known-no-cover track, where `has_cover` is false).
pub fn get_cover(
  conn: &Conn,
  path: &str,
) -> rusqlite::Result<Option<CachedCover>> {
  conn
    .query_row(
      "SELECT has_cover, cover_blob, cover_mime FROM tracks WHERE path = ?1",
      params![path],
      |r| Ok((r.get::<_, i64>(0)? != 0, r.get(1)?, r.get(2)?)),
    )
    .optional()
}

// Playlists -------------------------------------------------------------------

pub fn load_playlists(conn: &Conn) -> rusqlite::Result<Vec<crate::Playlist>> {
  let mut stmt = conn.prepare(
    "SELECT id, name, created_at, updated_at FROM playlists ORDER BY position",
  )?;
  let metas: Vec<(String, String, i64, i64)> = stmt
    .query_map([], |r| {
      Ok((
        r.get::<_, String>(0)?,
        r.get::<_, String>(1)?,
        r.get::<_, i64>(2)?,
        r.get::<_, i64>(3)?,
      ))
    })?
    .collect::<rusqlite::Result<Vec<_>>>()?;
  drop(stmt);

  let mut playlists = Vec::with_capacity(metas.len());
  for (id, name, created_at, updated_at) in metas {
    let tracks = load_playlist_tracks(conn, &id)?;
    playlists.push(crate::Playlist {
      id,
      name,
      tracks,
      created_at: created_at as u64,
      updated_at: updated_at as u64,
    });
  }
  Ok(playlists)
}

fn load_playlist_tracks(
  conn: &Conn,
  playlist_id: &str,
) -> rusqlite::Result<Vec<crate::TrackRef>> {
  let mut stmt = conn.prepare(
    "SELECT artist, title FROM playlist_tracks WHERE playlist_id = ?1 ORDER BY position",
  )?;
  let rows = stmt.query_map(params![playlist_id], |r| {
    Ok(crate::TrackRef {
      artist: r.get(0)?,
      title: r.get(1)?,
    })
  })?;
  rows.collect()
}

// Persist the full playlist set. The whole collection is small and only one
// writer ever runs, so a delete-all + reinsert inside a transaction is the
// simplest correct approach. The playlist_tracks rows are removed via the
// ON DELETE CASCADE foreign key.
pub fn save_playlists(
  conn: &Conn,
  playlists: &[crate::Playlist],
) -> rusqlite::Result<()> {
  let tx = conn.unchecked_transaction()?;
  tx.execute("DELETE FROM playlists", [])?;
  for (pos, p) in playlists.iter().enumerate() {
    tx.execute(
      "INSERT INTO playlists (id, name, created_at, updated_at, position)
       VALUES (?1, ?2, ?3, ?4, ?5)",
      params![
        p.id,
        p.name,
        p.created_at as i64,
        p.updated_at as i64,
        pos as i64
      ],
    )?;
    for (tpos, t) in p.tracks.iter().enumerate() {
      tx.execute(
        "INSERT INTO playlist_tracks (playlist_id, position, artist, title)
         VALUES (?1, ?2, ?3, ?4)",
        params![p.id, tpos as i64, t.artist, t.title],
      )?;
    }
  }
  tx.commit()?;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  // A fresh, isolated on-disk database per test. A unique name avoids clashes
  // between tests running in parallel; a file (rather than `:memory:`) is used
  // because each pooled connection to an in-memory database is a *separate*
  // database. The pool is capped at one connection so the test always talks to
  // the same database. Stale files from a previous run are removed first.
  fn temp_pool(name: &str) -> Pool {
    let mut path = std::env::temp_dir();
    path.push(format!("tunediver-test-{name}.db"));
    for suffix in ["", "-wal", "-shm"] {
      let p = PathBuf::from(format!("{}{}", path.display(), suffix));
      let _ = std::fs::remove_file(&p);
    }
    let manager = SqliteConnectionManager::file(&path)
      .with_init(|c| c.execute_batch("PRAGMA foreign_keys=ON;"));
    let pool = r2d2::Pool::builder().max_size(1).build(manager).unwrap();
    init_schema(&pool.get().unwrap()).unwrap();
    pool
  }

  fn sample_track(path: &str) -> CachedTrack {
    CachedTrack {
      path: path.to_string(),
      mtime: 100,
      size: 200,
      artist: "Artist".to_string(),
      title: "Title".to_string(),
      lyrics: None,
      date_added: None,
      has_cover: false,
      cover_blob: None,
      cover_mime: None,
    }
  }

  #[test]
  fn load_catalog_orders_by_path_with_sequential_ids() {
    let pool = temp_pool("catalog_order");
    let conn = pool.get().unwrap();
    // Insert out of order; load_catalog must sort by path and assign ids 0..n.
    for p in ["/m/c.mp3", "/m/a.mp3", "/m/b.mp3"] {
      upsert_track(&conn, &sample_track(p)).unwrap();
    }
    let catalog = load_catalog(&conn).unwrap();
    let rows: Vec<(usize, String)> = catalog
      .tracks
      .iter()
      .map(|t| (t.id, t.path.to_string_lossy().into_owned()))
      .collect();
    assert_eq!(
      rows,
      vec![
        (0, "/m/a.mp3".to_string()),
        (1, "/m/b.mp3".to_string()),
        (2, "/m/c.mp3".to_string()),
      ]
    );
  }

  #[test]
  fn upsert_replaces_existing_row_by_path() {
    let pool = temp_pool("upsert_replace");
    let conn = pool.get().unwrap();
    upsert_track(&conn, &sample_track("/m/song.mp3")).unwrap();
    let mut updated = sample_track("/m/song.mp3");
    updated.title = "New Title".to_string();
    updated.mtime = 999;
    upsert_track(&conn, &updated).unwrap();

    let catalog = load_catalog(&conn).unwrap();
    assert_eq!(catalog.tracks.len(), 1, "same path must not duplicate");
    assert_eq!(catalog.tracks[0].title, "New Title");

    let stamps = load_track_stamps(&conn).unwrap();
    assert_eq!(stamps.get("/m/song.mp3"), Some(&(999, 200)));
  }

  #[test]
  fn track_stamps_drive_change_detection() {
    let pool = temp_pool("stamps");
    let conn = pool.get().unwrap();
    let mut a = sample_track("/m/a.mp3");
    a.mtime = 10;
    a.size = 20;
    upsert_track(&conn, &a).unwrap();
    let stamps = load_track_stamps(&conn).unwrap();
    assert_eq!(stamps.get("/m/a.mp3"), Some(&(10, 20)));
    assert_eq!(stamps.get("/m/missing.mp3"), None);
  }

  #[test]
  fn delete_track_removes_row() {
    let pool = temp_pool("delete");
    let conn = pool.get().unwrap();
    upsert_track(&conn, &sample_track("/m/a.mp3")).unwrap();
    delete_track(&conn, "/m/a.mp3").unwrap();
    assert!(load_catalog(&conn).unwrap().tracks.is_empty());
  }

  #[test]
  fn track_detail_returns_cached_values_or_none() {
    let pool = temp_pool("detail");
    let conn = pool.get().unwrap();
    let mut t = sample_track("/m/a.mp3");
    t.lyrics = Some("la la".to_string());
    t.date_added = Some("2024-01-01".to_string());
    upsert_track(&conn, &t).unwrap();

    let got = get_track_detail(&conn, "/m/a.mp3").unwrap();
    assert_eq!(
      got,
      Some((Some("la la".to_string()), Some("2024-01-01".to_string())))
    );
    // Unknown path → None (e.g. an in-flight initial scan).
    assert_eq!(get_track_detail(&conn, "/m/missing.mp3").unwrap(), None);
  }

  #[test]
  fn cover_positive_and_negative_cache() {
    let pool = temp_pool("cover");
    let conn = pool.get().unwrap();

    // Track with embedded art.
    let mut with = sample_track("/m/with.mp3");
    with.has_cover = true;
    with.cover_blob = Some(vec![1, 2, 3]);
    with.cover_mime = Some("image/png".to_string());
    upsert_track(&conn, &with).unwrap();

    // Track known to have no art (negative cache).
    upsert_track(&conn, &sample_track("/m/without.mp3")).unwrap();

    assert_eq!(
      get_cover(&conn, "/m/with.mp3").unwrap(),
      Some((true, Some(vec![1, 2, 3]), Some("image/png".to_string())))
    );
    let (has, blob, _) = get_cover(&conn, "/m/without.mp3").unwrap().unwrap();
    assert!(!has, "no-cover track must be cached as has_cover=false");
    assert!(blob.is_none());
    // Not-yet-scanned track → None (distinct from a known-no-cover track).
    assert_eq!(get_cover(&conn, "/m/missing.mp3").unwrap(), None);
  }

  #[test]
  fn playlists_round_trip_preserves_order() {
    let pool = temp_pool("pl_round_trip");
    let conn = pool.get().unwrap();
    let playlists = vec![
      crate::Playlist {
        id: "pl_b".to_string(),
        name: "Second".to_string(),
        tracks: vec![crate::TrackRef {
          artist: "Fred".to_string(),
          title: "Robot Poetry".to_string(),
        }],
        created_at: 5,
        updated_at: 6,
      },
      crate::Playlist {
        id: "pl_a".to_string(),
        name: "First".to_string(),
        tracks: vec![
          crate::TrackRef {
            artist: "A".to_string(),
            title: "One".to_string(),
          },
          crate::TrackRef {
            artist: "B".to_string(),
            title: "Two".to_string(),
          },
        ],
        created_at: 1,
        updated_at: 2,
      },
    ];
    save_playlists(&conn, &playlists).unwrap();

    let loaded = load_playlists(&conn).unwrap();
    // Playlist insertion order is preserved via the `position` column...
    let names: Vec<&str> = loaded.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(names, vec!["Second", "First"]);
    // ...as is the per-playlist track order.
    let second = &loaded[1];
    assert_eq!(second.id, "pl_a");
    assert_eq!(second.created_at, 1);
    let tracks: Vec<(&str, &str)> = second
      .tracks
      .iter()
      .map(|t| (t.artist.as_str(), t.title.as_str()))
      .collect();
    assert_eq!(tracks, vec![("A", "One"), ("B", "Two")]);
  }

  #[test]
  fn save_playlists_replaces_previous_set() {
    let pool = temp_pool("pl_replace");
    let conn = pool.get().unwrap();
    save_playlists(
      &conn,
      &[crate::Playlist {
        id: "pl_old".to_string(),
        name: "Old".to_string(),
        tracks: vec![crate::TrackRef {
          artist: "X".to_string(),
          title: "Y".to_string(),
        }],
        created_at: 1,
        updated_at: 1,
      }],
    )
    .unwrap();
    // Saving a new set replaces the old; cascade clears orphaned tracks.
    save_playlists(
      &conn,
      &[crate::Playlist {
        id: "pl_new".to_string(),
        name: "New".to_string(),
        tracks: vec![],
        created_at: 2,
        updated_at: 2,
      }],
    )
    .unwrap();

    let loaded = load_playlists(&conn).unwrap();
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].id, "pl_new");

    // No orphaned playlist_tracks rows remain (ON DELETE CASCADE fired).
    let orphans: i64 = conn
      .query_row("SELECT COUNT(*) FROM playlist_tracks", [], |r| r.get(0))
      .unwrap();
    assert_eq!(orphans, 0);
  }
}
