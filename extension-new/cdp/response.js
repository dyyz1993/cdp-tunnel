var ResponseBuilder = (function() {
  function success(id, result, sessionId) {
    var response = { id: id, result: result || {} };
    if (sessionId) response.sessionId = sessionId;
    return response;
  }

  function error(id, message, sessionId) {
    var response = { id: id, error: { message: message } };
    if (sessionId) response.sessionId = sessionId;
    return response;
  }

  function send(id, result, sessionId, errorMessage) {
    var response;
    if (errorMessage) {
      response = ResponseBuilder.error(id, errorMessage, sessionId);
    } else {
      response = ResponseBuilder.success(id, result, sessionId);
    }
    WebSocketManager.send(response);
    return response;
  }

  return {
    success: success,
    error: error,
    send: send
  };
})();

var EventBuilder = (function() {
  function build(method, params, sessionId) {
    var event = { type: 'event', method: method, params: params };
    if (sessionId) event.sessionId = sessionId;
    return event;
  }

  function send(method, params, sessionId) {
    var event = EventBuilder.build(method, params, sessionId);
    WebSocketManager.send(event);
    console.log('[EventBuilder.send]', method);
    return event;
  }

  return {
    build: build,
    send: send
  };
})();
