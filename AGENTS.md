# Project Guide

Seattle Bike Comfort is a map for exploring bike routes and reachable areas. The repository also includes a traffic-volume map. See the README files for setup, deployment, and data sources.

## Routing and map changes

- Check `public/config.json` and the related source code before changing routing, road classification, colors, or reachability. Keep adjustable values in the config file instead of copying them into this guide.
- Treat route comfort as an OpenStreetMap-based estimate, not a crash-risk score or a safety guarantee.
- Keep generated map data in sync with its source data and config. Use the scripts in `package.json` to rebuild it; avoid editing generated files by hand.
- Keep the required OpenStreetMap attribution when changing map tiles or map layout.

## Data

- Read the relevant data README before changing source data or its build scripts.
- Large traffic source exports and Parquet files are local research data. They are ignored by Git and are not needed to build the web app.

## Development

- Use the scripts in `package.json` for checks that fit the change.
- Add a small regression test for new behavior. Keep comments short and describe how the code works now.
