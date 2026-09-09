// Reverse proxy in front of the 4 microservices. This is what client/ keeps
// pointing its single API_URL and Socket.IO connection at (port 3000,
// exactly where the original server/ monolith used to listen) — routing by
// path prefix means the client needed zero changes for the split.
require('dotenv').config();
const express = require('express');
const chalk = require('chalk');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');

const port = process.env.PORT || 3000;
const apiURL = process.env.BASE_API_URL || 'api';
const api = `/${apiURL}`;

const IDENTITY_URL = process.env.IDENTITY_URL;
const CATALOG_URL = process.env.CATALOG_URL;
const COMMERCE_URL = process.env.COMMERCE_URL;
const NOTIFICATION_URL = process.env.NOTIFICATION_URL;

const app = express();
app.use(cors());

// Path-prefix -> service routing table. Order matters only in that more
// specific paths would need to precede less specific ones — none overlap
// here, so registration order is arbitrary.
const routes = [
  { path: [`${api}/auth`, `${api}/user`, `${api}/address`], target: IDENTITY_URL },
  {
    path: [
      `${api}/product`,
      `${api}/category`,
      `${api}/brand`,
      `${api}/review`,
      `${api}/wishlist`
    ],
    target: CATALOG_URL
  },
  // commerce_server is a single GraphQL endpoint (not one REST path per
  // resource like the other three services) — see CLAUDE.md's
  // commerce_server section.
  { path: [`${api}/graphql`], target: COMMERCE_URL },
  { path: [`${api}/contact`, `${api}/notification`], target: NOTIFICATION_URL }
];

routes.forEach(({ path, target }) => {
  app.use(
    path,
    createProxyMiddleware({
      target,
      changeOrigin: true
    })
  );
});

app.use(api, (req, res) => res.status(404).json('No API route found'));

// Socket.IO's handshake (client/app/contexts/Socket connects to the same
// origin as API_URL) needs its own proxy with ws:true so the connection
// upgrades to a websocket through the gateway instead of terminating here.
const socketProxy = createProxyMiddleware({
  target: NOTIFICATION_URL,
  changeOrigin: true,
  ws: true
});
app.use('/socket.io', socketProxy);

const server = app.listen(port, () => {
  console.log(
    `${chalk.green('✓')} ${chalk.blue(
      `api_gateway listening on port ${port}. Visit http://localhost:${port}/ in your browser.`
    )}`
  );
});

// http-proxy-middleware needs the raw HTTP server's 'upgrade' event wired
// up separately to actually proxy websocket traffic — app.use() alone only
// handles regular HTTP requests.
server.on('upgrade', socketProxy.upgrade);
