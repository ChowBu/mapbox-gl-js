// @flow

'use strict';

const VT = require('@mapbox/vector-tile');
const Protobuf = require('pbf');
const assert = require('assert');
const promisify = require('pify');

const WorkerTile = require('../../src/source/worker_tile');
const Style = require('../../src/style/style');
const StyleLayerIndex = require('../../src/style/style_layer_index');
const Evented = require('../../src/util/evented');
const config = require('../../src/util/config');
const coordinates = require('../lib/coordinates');
const accessToken = require('../lib/access_token');
const deref = require('../../src/style-spec/deref');

const SAMPLE_COUNT = 10;
config.ACCESS_TOKEN = accessToken;

class Benchmark extends Evented {
    /**
     * The `setup` method is intended to be overridden by subclasses. It will be called once, prior to
     * running any benchmark iterations, and may set state on `this` which the benchmark later accesses.
     * If the setup involves an asynchronous step, `setup` may return a promise.
     */
    setup() {}

    /**
     * The `bench` method is intended to be overridden by subclasses. It should contain the code to be
     * benchmarked. It may access state on `this` set by the `setup` function (but should not modify this
     * state). It will be called multiple times, the total number to be determined by the harness. If
     * the benchmark involves an asynchronous step, `bench` may return a promise.
     */
    bench() {}

    /**
     * Run the benchmark by executing `setup` once and then sampling the execution time of `bench` some
     * number of times, while collecting performance statistics.
     * @returns Promise<{samples: Array<number>, regression: Array<[iterations: number, totalTime: number]>}>
     */
    run() {
        // (unfinished)
        Promise.resolve(this.setup())
            .then(() => this.runIterations(10))
            .then((elapsed) => this.fire('end', elapsed));
    }

    runIterations(n) {
        const start = performance.now();
        let promise = Promise.resolve();
        for (let i = 0; i < n; i++) {
            promise = promise.then(this.bench.bind(this));
        }
        return promise.then(() => performance.now() - start);
    }
}

/**
 * Individual files may export a single class deriving from `Benchmark`, or a "benchmark suite" consisting
 * of an array of such classes.
 */
module.exports = coordinates.map((coordinate) => {
    return class BufferBenchmark extends Benchmark {
        glyphs: Object;
        icons: Object;
        workerTile: WorkerTile;
        layerIndex: StyleLayerIndex;
        tile: ArrayBuffer;

        setup() {
            this.glyphs = {};
            this.icons = {};

            this.workerTile = new WorkerTile({
                coord: coordinate,
                zoom: coordinate.zoom,
                tileSize: 512,
                overscaling: 1,
                showCollisionBoxes: false,
                source: 'composite',
                uid: '0',
                maxZoom: 22,
                pixelRatio: 1,
                request: {
                    url: ''
                },
                angle: 0,
                pitch: 0,
                cameraToCenterDistance: 0,
                cameraToTileDistance: 0
            });

            const styleURL = `https://api.mapbox.com/styles/v1/mapbox/streets-v9?access_token=${accessToken}`;
            const tileURL = `https://a.tiles.mapbox.com/v4/mapbox.mapbox-terrain-v2,mapbox.mapbox-streets-v6/${coordinate.zoom}/${coordinate.row}/${coordinate.column}.vector.pbf?access_token=${accessToken}`;

            return Promise.all([fetch(styleURL), fetch(tileURL)])
                .then(([styleResponse, tileResponse]) => {
                    return new Promise((resolve, reject) => {
                        this.layerIndex = new StyleLayerIndex(deref(styleResponse.json().layers));
                        this.tile = tileResponse.arrayBuffer();

                        const style = new Style(styleResponse.json(), (new StubMap(): any), {})
                            .on('error', reject)
                            .on('data', () => {
                                const preloadGlyphs = (params, callback) => {
                                    style.getGlyphs(0, params, (err, glyphs) => {
                                        this.glyphs[JSON.stringify(params)] = glyphs;
                                        callback(err, glyphs);
                                    });
                                };

                                const preloadImages = (params, callback) => {
                                    style.getImages(0, params, (err, icons) => {
                                        this.icons[JSON.stringify(params)] = icons;
                                        callback(err, icons);
                                    });
                                };

                                this.bench(preloadGlyphs, preloadImages)
                                    .then(resolve, reject);
                            });
                    });
                });
        }

        bench(getGlyphs = (params, callback) => callback(null, this.glyphs[JSON.stringify(params)]),
              getImages = (params, callback) => callback(null, this.icons[JSON.stringify(params)])) {

            const actor = {
                send(action, params, callback) {
                    setTimeout(() => {
                        if (action === 'getImages') {
                            getImages(params, callback);
                        } else if (action === 'getGlyphs') {
                            getGlyphs(params, callback);
                        } else assert(false);
                    }, 0);
                }
            };

            return promisify(this.workerTile.parse)(new VT.VectorTile(new Protobuf(this.tile)), this.layerIndex, actor);
        }
    }
});

class StubMap extends Evented {
    _transformRequest(url) {
        return { url };
    }
}
