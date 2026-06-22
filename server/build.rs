use std::process::Command;

// Embed the frontend into the binary. rust-embed bakes `../frontend/public`
// into the release binary at compile time, so we build the frontend's TypeScript
// here first to make sure the embedded assets are the compiled `.js`, not stale
// or missing output. Only done for release builds: in debug, rust-embed reads
// the files from disk at runtime, so the frontend is built separately via
// `cd frontend && make build` during normal dev.
fn main() {
  let profile = std::env::var("PROFILE").unwrap_or_default();

  // Re-embed whenever the frontend output or its sources change.
  println!("cargo:rerun-if-changed=../frontend/public");
  println!("cargo:rerun-if-changed=../frontend/package.json");

  if profile != "release" {
    return;
  }

  let frontend = std::path::Path::new("../frontend");
  if !frontend.exists() {
    println!("cargo:warning=../frontend not found; embedding existing assets");
    return;
  }

  let status = Command::new("make")
    .arg("build")
    .current_dir(frontend)
    .status();

  match status {
    Ok(s) if s.success() => {}
    Ok(s) => {
      panic!("frontend build failed ({s}); cannot embed frontend assets")
    }
    Err(e) => {
      panic!("could not run frontend build (`make build` in ../frontend): {e}")
    }
  }
}
