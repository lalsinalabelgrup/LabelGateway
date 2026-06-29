const { EventEmitter } = require('events');

class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
  }
}

module.exports = new EventBus();
