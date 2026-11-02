# Changelog

## 0.1.0 (2026-10-27)

- Initial release: `analyze_dockerfile_layers` MCP tool and
  `analyze` CLI command for Dockerfile layer and waste
  analysis.
- Parses instructions honouring `\` continuations and skipping
  blank lines and comments; counts RUN / COPY / ADD layers,
  aligns caller-supplied layer sizes, and ranks the biggest
  layers first.
- Waste flags: `CONSECUTIVE_RUN`, `BROAD_COPY_EARLY`,
  `APT_LEFTOVER`, `ADD_LOCAL`.
