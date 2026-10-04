# Seattle Bike Comfort

A Seattle bike map that shows green-reachable distance by street. The default view covers an approximate rectangular Seattle area; the settings menu also offers click-to-view comfort.

To run it, install the dependencies and start the app:

```sh
npm install
npm run dev
```

Open the local address printed in your terminal.

## Deploy to GitHub Pages

The `Deploy to GitHub Pages` workflow builds and publishes the app whenever a commit is pushed to `main`. In the repository settings, open **Pages** and set the build and deployment source to **GitHub Actions**. The workflow deploys both the main map and `traffic-volume.html`.

The Vite build uses relative asset and data URLs, so the same deployment works at the GitHub Pages project URL and on a custom domain. When you are ready to use a custom domain, add a `public/CNAME` file containing the domain, configure its DNS records, and enter the domain in **Settings → Pages**.

To rebuild the browser road extract from the local OSM data, run `npm run data:build`. After changing the road data or risk config, run `npm run data:precompute` to refresh reachability and routing-graph caches. `npm run data:precompute-graph` rebuilds only the routing graph. The app loads that compact graph cache only when click-to-view comfort is selected. `npm run data:fetch` refreshes OSM data from Overpass and regenerates the browser extracts.
