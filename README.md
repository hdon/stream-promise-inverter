# stream-promise-inverter
Write Node.js Transform Streams Using Promise/async+await

If you're using Node.js Streams and are writing something like a simple parser (although you should never write a complex parser by hand! Please use a parser generator!) you shouldn't have to manage any extra state than you have to.

By utilizing [IoC] and [async+await], you can write better code:

```javascript
const Inverter = require('./stream-promise-inverter');
process.stdin.pipe(new Inverter(async inverter => {
  let lineBuf;
  /* get first line */
  lineBuf = await inverter.readUntil(10);
  console.log('a>', lineBuf.toString('utf8'))
  /* get second line */
  lineBuf = await inverter.readUntil(10);
  console.log('b>', lineBuf.toString('utf8'))
  inverter.end();
}))
```

## Alternatives

You might also like [RxJS].

It looks like RxJS has facilities for managing [back-pressure], which was the one requirement I really thought might not be accommodated by RxJS. Oh, well! :cat:

You're probably also using Node.js Streams if you're reading this. So, if you like RxJS then you might want to take a look at [rx-node] and [rxjs-stream].

## Notes

### Tests?

This isn't well tested right now.

### Node.js Streams Already IoC

Yeah, yeah, I suppose that's true. IoIoC then?

### What About Object Mode?

[Object Mode] is currently not supported. Sorry.

[IoC]: https://en.wikipedia.org/wiki/Inversion_of_control
[async+await]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/async_function
[RxJS]: https://github.com/reactivex/rxjs
[back-pressure]: https://github.com/Reactive-Extensions/RxJS/blob/master/doc/gettingstarted/backpressure.md#controlled-observables
[rx-node]: https://www.npmjs.com/package/rx-node
[rxjs-stream]: https://www.npmjs.com/package/rxjs-stream
[Object Mode]: https://nodejs.org/api/stream.html#stream_object_mode
