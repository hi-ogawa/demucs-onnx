//! Shared demucs vocabulary beside the engine: name<->enum mapping and the model
//! registry (bag specs mirroring demucs/remote/*.yaml). The engine itself never
//! parses or formats names; drivers use this at their edges.

use crate::{Bag, Mode, Source};
use anyhow::{anyhow, bail, Result};

impl Mode {
    /// Build from the drivers' shared name pair: an optional two-stems source name and
    /// an optional method name ("add", the default, or "minus"). A method without a
    /// source is rejected rather than ignored.
    pub fn parse(two_stems: Option<&str>, method: Option<&str>) -> Result<Mode> {
        let source = two_stems.map(Source::parse).transpose()?;
        match (source, method) {
            (None, None) => Ok(Mode::Full),
            (None, Some(_)) => bail!("method requires two-stems"),
            (Some(s), None | Some("add")) => Ok(Mode::Add(s)),
            (Some(s), Some("minus")) => Ok(Mode::Minus(s)),
            (Some(_), Some(m)) => bail!("unknown method {m} (expected add or minus)"),
        }
    }
}

impl Source {
    pub fn name(self) -> &'static str {
        match self {
            Source::Drums => "drums",
            Source::Bass => "bass",
            Source::Other => "other",
            Source::Vocals => "vocals",
        }
    }

    pub fn parse(name: &str) -> Result<Source> {
        Source::ALL
            .into_iter()
            .find(|s| s.name() == name)
            .ok_or_else(|| anyhow!("unknown source {name} (expected drums/bass/other/vocals)"))
    }
}

/// One bag member, by identity. How a member is stored (file name, URL) is the
/// driver's concern.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Member {
    Htdemucs,
    HtdemucsFt(Source),
}

/// Resolve a model config to the member runs it needs and the engine's bag shape:
/// which members run (identities, in member order — the driver loads these) and how
/// their outputs map to stems (minus two-stems runs only the target's specialist).
pub fn select(model: &str, mode: Mode) -> Result<(Vec<Member>, Bag)> {
    Ok(match model {
        "htdemucs" => (vec![Member::Htdemucs], Bag::AllFromOne),
        "htdemucs_ft" => match mode {
            Mode::Minus(src) => (vec![Member::HtdemucsFt(src)], Bag::Single(src)),
            _ => (
                Source::ALL.into_iter().map(Member::HtdemucsFt).collect(),
                Bag::PerStem,
            ),
        },
        _ => bail!("unknown model name: {model}"),
    })
}
