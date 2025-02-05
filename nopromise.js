/*
 * NoPromise: Promise A+ compliant implementation, also with ES6 interface
 * Copyright 2016  Avi Halachmi (:avih)  http://github.com/avih/nopromise
 * License: MIT
 *
 * Interface, e.g. after var Promise = require("nopromise") :
 *   new Promise(function executor(resolveFn, rejectFn) { ... })
 *   Promise.prototype.then(onFulfilled, onRejected)
 *   Promise.prototype.catch(onRejected)
 *   Promise.prototype.finally(onFinally)
 *   Promise.resolve(value)
 *   Promise.reject(reason)
 *   Promise.all(iterator)
 *   Promise.race(iterator)
 *
 * Legacy interface is also supported:
 *   Promise.defer()  or  Promise.deferred()
 *   Promise.prototype.resolve(value)
 *   Promise.prototype.reject(reason)
 */

var muPromise = (function(){

// Promise terminology:
// State: begins with pending, may move once to fulfilled+value/rejected+reason.
// Settled: at its final fulfilled/rejected state.
// Resolved = sealed fate: settled or (pending and) follows another thenable T.
//   resolved + pending = follows only T - ignores later resolve/reject calls.
// Thenable = has .then(): promise but not necessarily our implementation.
// Note: the API has reject(r)/resolve(v) but not fulfill(v). that is because:
//   resolve(v) already fulfills with value v if v is not a promise.
//   if v is a promise then it should be followed - not be a fulfilled value.
//   hence resolve(v) either fulfills with v, or follows + seals the fate to v.

var globalQ,
    async,
    FULFILLED = 1,
    REJECTED  = 2,
    FUNCTION  = "function";

async = setTimeout;


// The invariant between internalAsync and dequeue is that if globalQ is thuthy,
// then a dequeue is already scheduled and will execute globalQ asynchronously,
// otherwise, globalQ needs to be created and dequeue needs to be scheduled.
// The elements (functions) of the globalQ array need to be invoked in order.
function dequeue() {
    var f, tmp = globalQ.reverse();
    globalQ = 0;
    while (f = tmp.pop())
        f();
}

// This is used throughout the implementation as the asynchronous scheduler.
// While satisfying the contract to invoke f asynchronously, it batches
// individual f's into a single group which is later iterated synchronously.
function internalAsync(f) {
    if (globalQ) {
        globalQ.push(f);
    } else {
        globalQ = [f];
        async(dequeue);
    }
}

// fulfill/reject a promise if it's pending, else no-op.
function settle(p, state, value) {
    if (!p._state) {
        p._state = state;
        p._output = value;

        var f, arr = p._resolvers;
        if (arr) {
            // The case where `then` is called many times for the same promise
            // is rare, so for simplicity, we're not optimizing for it, or else
            // if globalQ is empty, we can just do: globalQ = p._resolvers;
            arr.reverse();
            while (f = arr.pop())
                internalAsync(f);
        }
    }
}

function reject(promise, reason) {
    promise._sealed || promise._state || settle(promise, REJECTED, reason);
}

// a promise's fate may be set only once. fullfill/reject trivially set its fate
// (and also settle it), but resolving it with another promise P must also seal
// its fate, such that no later fulfill/reject/resolve are allowed to affect its
// fate - onlt P will do so once/if it settles.
// promise here is always NoPromise, but x might be a value/NoPromise/thenable.
function resolve(promise, x, decidingFate) {
    if (promise._state || (promise._sealed && !decidingFate))
        return;
    // seal fate. only this instance of resolve can settle it [recursively]
    promise._sealed = 1;

    var then,
        done = 0;

    try {
        if (x == promise) {
            settle(promise, REJECTED, TypeError());

        } else if (x instanceof NoPromise && x._state) {
            // we can settle synchronously if we know that x is settled and also
            // know how to adopt its state, which we do when x is NoPromise.
            settle(promise, x._state, x._output);

        // Check for generic thenable... which includes unsettled NoPromise.
        } else if ((x && typeof x == "object" || typeof x == FUNCTION)
                   && typeof (then = x.then) == FUNCTION) {
            then.call(x, function(y) { done++ || resolve(promise, y, 1) },  // decidingFate
                         function(r) { done++ || settle(promise, REJECTED, r)});

        } else {
            settle(promise, FULFILLED, x);
        }

    } catch (e) {
        done++ || settle(promise, REJECTED, e);
    }
}

// Other than the prototype methods, the object may also have:
// ._state    : 1 if fulfilled, 2 if rejected (doesn't exist otherwise).
// ._output   : value if fulfilled, reason if rejected (doesn't exist otherwise).
// ._resolvers: array of functions (closures) for each .then call while pending (if there were any).
// ._sealed   : new resolve/reject are ignored (exists if resolve was called).

NoPromise.prototype = {
    // Each call to `then` returns a new NoPromise object and creates a closure
    // which is used to resolve it after then's this is fulfilled/rejected.
    then: function(onFulfilled, onRejected) {
        var _self    = this,
            promise2 = new NoPromise;

        this._state ? internalAsync(promise2Resolver)
                    : this._resolvers ? this._resolvers.push(promise2Resolver)
                                      : this._resolvers = [promise2Resolver];
        return promise2;

        // Invoked asynchronously to `then` and after _self is settled.
        // _self._state here is FULFILLED/REJECTED
        function promise2Resolver() {
            var handler = _self._state == FULFILLED ? onFulfilled : onRejected;

            // no executor for promise2, so not yet sealed, but the legacy API
            // can make it already sealed here, e.g. p2=p.then(); p2.resolve(X)
            // So we still need to check ._sealed before settle(..) below
            if (typeof handler != FUNCTION) {
                promise2._sealed || settle(promise2, _self._state, _self._output);
            } else {
                try {
                    resolve(promise2, handler(_self._output));
                } catch (e) {
                    reject(promise2, e);
                }
            }
        }
    },  // then

    catch: function(onRejected) {
        return this.then(undefined, onRejected);
    },

    // P.finaly(fn) returns a promise X, and calls fn after P settles as S.
    // if fn throws E: X is rejected with E.
    // Else if fn returns a promise F: X is settled once F is settled:
    //   If F is rejected with FJ: X is rejected with FJ.
    // Else: X settles as S [ignoring fn's retval or F's fulfillment value]
    finally: function(onFinally) {
        function fin_noargs() { return onFinally() }
        var fn;
        return this
            .then(function(v) { fn = function() { return v } },
                  function(r) { fn = function() { throw r } })
            .then(fin_noargs, fin_noargs)
            .then(function finallyOK() { return fn() });
    },
}


// CTOR:
//   return new NoPromise(function(resolve, reject) { setTimeout(function() { resolve(42); }, 100); });
function NoPromise(executor) {
    if (executor) {  // not used inside 'then' nor by the legacy interface
        var self = this;
        try {
            executor(function(v) { resolve(self, v) },
                     function(r) { reject(self, r) });
        } catch (e) {
            reject(self, e);
        }
    }
}


// detect a generic thenable - same logic as at resolve(). may throw.
function is_thenable(x) {
    return ((x && typeof x == "object") || typeof x == FUNCTION)
           && typeof x.then == FUNCTION;
}

// Static methods
// --------------

// Returns a resolved/rejected promise with specified value(or promise)/reason
NoPromise.resolve = function(v) {
    return new NoPromise(function(res, rej) { res(v) });
};

NoPromise.reject = function(r) {
    return new NoPromise(function(res, rej) { rej(r) });
};


// For .all and .race: we support iterators as array or array-like, and slack
// when it comes to throwing on invalid iterators (we only try [].slice.call).

// Static NoPromise.all(iter) returns a promise X.
// If iter is empty: X fulfills synchronously to an empty array.
// Else for the first promise in iter which rejects with J: X rejects a-sync with J.
// Else (all fulfill): X fulfills a-sync to an array of iter's fulfilled-values
// (non-promise values are considered already fulfilled with that value).
NoPromise.all = function(iter) {
    Array.isArray(iter) || (iter = [].slice.call(iter));
    var len = iter.length;
    if (!len)
        return NoPromise.resolve([]);  // empty fulfills synchronously

    return new NoPromise(function(allful, allrej) {
        var rv = [], pending = 0;
        function fulOne(i, val) { rv[i] = val; --pending || allful(rv); }

        iter.forEach(function(v, i) {
            if (is_thenable(v)) {
                pending++;
                v.then(fulOne.bind(null, i), allrej);
            } else {
                rv[i] = v;
            }
        });

        // Non empty but without promises - fulfills a-sync
        if (!pending)
            NoPromise.resolve(rv).then(allful);
    });
}

// Static NoPromise.race(iter) returns a promise X:
// If iter is empty: X never settles.
// Else: X settles always a-sync and mirrors the first promise in iter which settles.
// (non-promise values are considered already fulfilled with that value).
NoPromise.race = function(iter) {
    return new NoPromise(function(allful, allrej) {
        Array.isArray(iter) || (iter = [].slice.call(iter));
        iter.some(function(v, i) {
            if (is_thenable(v)) {
                v.then(allful, allrej);
            } else {
                NoPromise.resolve(v).then(allful);
                return true;  // continuing would end up no-op
            }
        });
    });
}


// Legacy interface - not used elsewhere in NoPromise, used by the test suit (below)
//   var d = NoPromise.defer(); setTimeout(function() { d.resolve(42); }, 100); return d.promise;
NoPromise.defer = function() {
    var d = new NoPromise;
    return d.promise = d;
};

NoPromise.prototype.resolve = function(value) {
    resolve(this, value);
}

NoPromise.prototype.reject = function(reason) {
    reject(this, reason);
}
// End of legacy interface

// Promises/A+ Compliance Test Suite
// https://github.com/promises-aplus/promises-tests
// nopromise.js itself can be the adapter: promises-aplus-tests ./nopromise.js
// The only required modification is that it wants different names - dup below.
NoPromise.deferred = NoPromise.defer;    // Static legacy API
NoPromise.resolved = NoPromise.resolve;  // Static standard, optional but tested
NoPromise.rejected = NoPromise.reject;   // Static standard, optional but tested
// The tests also use the legacy dynamic API: prototype.resolve(v)/.reject(r)


return NoPromise;

})();

var muGlobal = (Function("return this"))();
if (!muGlobal.Promise) {
    muGlobal.Promise = muPromise;
}
export default muPromise;
