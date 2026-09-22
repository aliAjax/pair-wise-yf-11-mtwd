const http = require("http");
const { handle } = require("./lib/routes");
const { send } = require("./lib/http");

const PORT = Number(process.env.PORT || 3020);

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

server.listen(PORT, () => {
  console.log(`Rubbing repair API running at http://127.0.0.1:${PORT}`);
});
