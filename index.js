/* Inversion of control for node.js transform streams using promises.
 * combine with async/await for fun and profit!
 *
 * References:
 *
 * https://nodejs.org/api/stream.html
 *
 * http://codewinds.com/blog/2013-08-20-nodejs-transform-streams.html
 */
const stream = require('stream');
const util = require('util');

/* Read modes
 * TODO document
 */
/* Not currently reading anything... In this mode, we will apply back
 * pressure to our read stream
 */
const READ_NONE = 'READ_NONE';
/* Buffer a certain number of bytes, then resolve pending read operation
 * with a single Buffer containing the number of bytes requested.
 */
const READ_BYTES = 'READ_BYTES';
/* Buffer all bytes until a specific byte value is seen, then resolve
 * pending read operation with a single buffer containing all bytes up to
 * and including the requested byte.
 */
const READ_UNTIL_BYTE = 'READ_UNTIL_BYTE';

/* TODO document
 *
 * when Inverter first gets data, it will invoke transformer, passing it a
 * reference to an object containing read functions to read from the
 * Inverter. All read functions return promises, so can be used with
 * async/await.
 *
 * TODO
 *
 * Also, maybe if transformer() itself returns a promise (which it probably
 * does,) then maybe a resolution or rejection of that promise should shut
 * down the stream somehow?
 */
function Inverter(transformer) {
  /* Transform streams must call Transform constructor */
  stream.Transform.call(this);

  /* Our buffer */
  let chunks = [];
  /* Current read position within chunks[0] */
  let cursor = 0;
  /* Track bytes stored */
  let bytesStored = 0;
  /* Track progress for fun */
  let bytesDisposed = 0;
  /* Read mode */
  let readMode = READ_NONE;
  /* State for READ_BYTES */
  let requestedByteCount = null;
  /* State for READ_UNTIL_BYTE */
  let requestedByteValue = null;
  /* null when readMode == READ_NONE; otherwise, these are the resolve()
   * and reject() interfaces of the promise we made to our transformer when
   * last it called one of our reading interfaces.
   *
   * TODO make sure we're catching errors everywhere and sending them along
   * as rejections
   */
  let readResolve = null;
  let readReject = null;
  /* This variable will refer to the callback function that lets the stream
   * we are reading from know that we can accommodate more data. I think we
   * should only call this function once and then discard the reference
   * (TODO confirm) and its first argument can be an error object if we
   * have had an error.
   *
   * We'll call this if we encounter an error, but mostly we will call it
   * when we are trying to fulfill a read operation and don't have enough
   * data yet.
   *
   * "The callback function must be called only when the current chunk is
   * completely consumed."
   *
   * https://nodejs.org/api/stream.html#stream_transform_transform_chunk_encoding_callback
   */
  let transformCallback = null;

  /* Re-evaluate current read mode vs. current buffer
   * NOTE: This flush function is unrelated to nodejs streams' flush
   */
  const flush = () => {
    let buf;
    switch (readMode) {
      /* Do nothing in READ_NONE read mode */
      case READ_NONE:
        return;
      case READ_BYTES:
        /* will be null if we don't have enough data buffered to fulfill
         * this read request
         */
        buf = shiftBytesToNewBuffer(requestedByteCount);
        break;
      case READ_UNTIL_BYTE:
        /* TODO maintain a scan cursor so we don't rescan the same bytes.
         *
         * findByte() will just return -1 if it can't find the value we're
         * looking for, so in that case shiftBytesToNewBuffer() will just
         * return null
         */
        buf = shiftBytesToNewBuffer(findByte(requestedByteValue));
    }
    /* fulfill read promise */
    if (buf === null) {
      /* Let the stream we are reading from know that we can accommodate more
       * data.
       */
      if (transformCallback !== null)
        transformCallback(null);
    }
    else {
      readResolve(buf);
    }
  }

  /* TODO catch errors anywhere they can happen and call fail() there */
  const fail = err => {
    /* Reject any pending read promise from our transformer */
    if (readReject)
      readReject(err)
    /* Let the stream we are reading from know about the error */
    if (transformCallback !== null)
      transformCallback(err);
  }

  /* Returns a single Buffer containing the first nBytes bytes of the
   * Buffers in chunks, shifts any exhausted Buffers out of chunks, and
   * adjusts bytesStored, bytesDisposed, and cursor accordingly.
   *
   * Just returns null if we haven't enough bytes to fulfill the operation,
   * or if nBytes < 1
   *
   * TODO can we do something with immutable or CoW buffers and buffer
   * slicing to avoid creating extra Buffers?
   */
  const shiftBytesToNewBuffer = nBytes => {
    if (nBytes < 1 || nBytes > bytesStored)
      return null;
    /* Adjust */
    bytesStored -= nBytes;
    bytesDisposed += nBytes;
    /* special case: first Buffer has the exact number of bytes we want and
     * cursor is at the beginning of the buffer
     */
    if (cursor === 0 && chunks[0].length === nBytes)
      return chunks.shift();
    /* create new buffer to hold result */
    const rval = new Buffer(nBytes);
    /* copy data from chunks into rval */
    let dstCursor = 0;
    let iChunk;
    let chunksToRemove = 0;
    for (iChunk = 0; dstCursor < nBytes; iChunk++) {
      const chunk = chunks[iChunk];
      const nBytesToCopy = Math.min(
        nBytes - dstCursor
      , chunk.length - cursor
      );
      chunk.copy(rval, dstCursor, cursor, cursor + nBytesToCopy);
      dstCursor += nBytesToCopy;
      cursor += nBytesToCopy;
      if (cursor == chunk.length) {
        chunksToRemove++;
        cursor = 0;
      }
    }
    /* remove any exhausted chunks */
    if (chunksToRemove)
      chunks = chunks.slice(chunksToRemove);
    /* done! */
    return rval;
  }

  /* Search each Buffer in chunks starting at cursor until we find a match,
   * then return its position relative to the cursor + 1. Return -1 if it
   * couldn't be found.
   *
   * TODO maintain a scan cursor so we don't re-scan the same bytes
   */
  const findByte = byteValue => {
    let pos = cursor, posInChunk = cursor;
    for (let iChunk=0; iChunk < chunks.length; iChunk++) {
      const chunk = chunks[iChunk];
      while (posInChunk < chunk.length) {
        if (chunk[posInChunk] === byteValue)
          return pos+1-cursor;
        pos++;
        posInChunk++;
      }
    }
    return -1;
  }

  /* Implementations for read functions */
  /* Decorator for read functions */
  const readFunction = fn => {
    const inverter = this; // XXX needed?
    return function() {
      /* We must not already be fulfilling a read op */
      if (readMode != READ_NONE)
        throw new Error('already fulfilling a read request');
      /* Invoke the wrapped read function */
      fn.apply(inverter, arguments);
      /* Create a promise and capture its resolve + reject interfaces. This
       * is the promise we will return to our transformer. readMode is also
       * reset when we resolve such a promise
       */
      const prom = new Promise((resolve, reject) => {
        readResolve = value => {
          readResolve = null;
          readReject = null;
          readMode = READ_NONE;
          resolve(value);
        }
        readReject = err => {
          readResolve = null;
          readReject = null;
          reject(err);
        };
      })
      /* Arrange to have the promise fulfilled ASAP if we have the requested
       * data available.
       *
       * NOTE I'm avoiding making this call synchronously to ensure
       * consistent async semantics, but I am neither sure that this is
       * necessary, nor am I sure that Promise doesn't already take care of
       * this for us
       *
       * https://nodejs.org/en/docs/guides/event-loop-timers-and-nexttick/#why-would-that-be-allowed
       *
       * TODO find out!
       */
      process.nextTick(flush);
      return prom;
    }
  }

  /* Implemented required method for Stream.Transform instances
   * https://nodejs.org/api/stream.html#stream_transform_transform_chunk_encoding_callback
   */
  this._transform = (chunk, enc, cb) => {
    chunks.push(chunk);
    bytesStored += chunk.length;
    /* XXX document */
    if (transformCallback !== null) {
      fail('got two transform callbacks');
    }
    /* "to receive the next chunk, callback must be called, either
     * synchronously or asynchronously"
     */
    transformCallback = err => {
      transformCallback = null;
      cb(err);
    }
    flush();
  }

  /* Initialize transformer, passing it some functions for it to reach us,
   * and making sure we clean up when it completes
   */
  transformer({
    read: readFunction(nBytes => {
      readMode = READ_BYTES;
      requestedByteCount = nBytes;
    })
  , readUntil: readFunction(byteValue => {
      if ((byteValue & 255) !== byteValue)
        throw new Error('argument must be integer 0-255');
      readMode = READ_UNTIL_BYTE;
      requestedByteValue = byteValue;
    })
  , write: value => {
      this.push(value)
    }
  , end: () => {
      this.end()
    }
  })
  .then(() => {this.end()})
  .catch(fail)
}

util.inherits(Inverter, stream.Transform);

module.exports = Inverter;
