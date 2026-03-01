const clients = new Set();

function addClient(res) {
  clients.add(res);
}

function removeClient(res) {
  clients.delete(res);
}

function sendEvent(event, payload) {
  const data = JSON.stringify(payload);
  for (const client of clients) {
    client.write(`event: ${event}\n`);
    client.write(`data: ${data}\n\n`);
  }
}

module.exports = {
  addClient,
  removeClient,
  sendEvent
};
