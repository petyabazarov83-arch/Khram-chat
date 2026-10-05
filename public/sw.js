self.addEventListener('notificationclick', function(event) {
  event.notification.close();

  if (event.action === 'accept_call') {
    event.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
        for (var i = 0; i < clientList.length; i++) {
          var client = clientList[i];
          if ('focus' in client) {
            client.postMessage({ action: 'accept_incoming_call' });
            return client.focus();
          }
        }
        if (clients.openWindow) {
          return clients.openWindow('/?action=accept_call');
        }
      })
    );
  }
});
