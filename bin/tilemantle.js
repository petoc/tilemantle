#!/usr/bin/env node

var fs = require('fs');
var es = require('event-stream');
var yargs = require('yargs');
var async = require('async');
var chalk = require('chalk');
var path = require('path');
var turf = require('@turf/turf');
var numeral = require('numeral');
var request = require('request');
var tilecover = require('@mapbox/tile-cover');
var humanizeDuration = require('humanize-duration');
var pkg = require('../package.json');
var ProgressBar = require('progress');
var bar;

var filesize = function (bytes) {
	return Number((bytes / 1024).toFixed(2)) + 'kB';
};

var argv = yargs(process.argv.slice(2))
	.usage('Usage: $0 <url> [<url> ...] [options]')
	.version('version', 'Display version number', pkg.version)
	.alias('h', 'help').describe('h', 'Display usage information').boolean('h')
	.alias('l', 'list').describe('l', 'Don\'t perform any requests, just list all tile URLs').boolean('l')
	.alias('a', 'allowfailures').describe('a', 'Skip failures, keep on truckin\'').boolean('a').default('allowfailures', true)
	.alias('z', 'zoom').describe('z', 'Zoom levels (comma separated list, range zmin-zmax or reversed range zmax-zmin)').string('z')
	.alias('e', 'extent').describe('e', 'Extent of region in the form of: nw_lat,nw_lon,se_lat,se_lon').string('e')
	.alias('f', 'file').describe('f', 'GeoJSON file on disk to use as geometry').string('f')
	.alias('p', 'point').describe('p', 'Center of region (use in conjunction with -b)').string('p')
	.alias('b', 'buffer').describe('b', 'Buffer point/geometry by an amount. Affix units at end: mi,km').string('b')
	.alias('d', 'delay').describe('d', 'Delay between requests. Affix units at end: ms,s').string('d').default('delay', '100ms')
	.alias('r', 'retries').describe('r', 'Number of retries').default('retries', 1)
	.alias('m', 'method').describe('m', 'HTTP method to use to fetch tiles').string('m').default('method', 'HEAD')
	.alias('H', 'header').describe('H', 'Add a request header').string('H')
	.alias('c', 'concurrency').describe('c', 'Number of tiles to request simultaneously').default('concurrency', 1)
	.alias('x', 'expiredlist').describe('x', 'Expired tiles list from osm2pgsql command').string('x')
	.check(function (argv) {
		if (!/^\d+(\.\d+)?(ms|s)$/.test(argv.delay)) throw new Error('Invalid "delay" argument');
		if (typeof argv.zoom !== 'undefined' && !/^((\d+\-\d+)|(\d+(,\d+)*))$/.test(argv.zoom)) throw new Error('Invalid "zoom" argument');
		return true;
	})
	.argv;

function displayHelp() {
	yargs.showHelp();
	console.log('');
	console.log('Examples:');
	console.log('');
	console.log('  $ tilemantle http://myhost.com/{z}/{x}/{y}.png --point=44.523333,-109.057222 --buffer=12mi --zoom=10-14');
	console.log('  $ tilemantle http://myhost.com/{z}/{x}/{y}.png --extent=44.523333,-109.057222,41.145556,-104.801944 --zoom=10-14');
	console.log('  $ tilemantle http://myhost.com/{z}/{x}/{y}.png --zoom=10-14 -f region.geojson');
	console.log('  $ tilemantle http://myhost.com/{z}/{x}/{y}.png --zoom=14-10 -f region.geojson');
	console.log('  $ tilemantle http://myhost.com/{z}/{x}/{y}.png --expiredlist expired.list');
	console.log('  $ cat region.geojson | tilemantle http://myhost.com/{z}/{x}/{y}.png --zoom=10-14');
	console.log('  $ cat region.geojson | tilemantle http://myhost.com/{z}/{x}/{y}.png --buffer=20mi --zoom=10-14');
	console.log('');
}

if (argv.help) {
	displayHelp();
	process.exit(0);
}

// parse options
var urltemplates = argv._;
var validateurlparam = function (template, param) {
	if (template.indexOf(param) === -1) {
		displayHelp();
		console.error('URL missing ' + param + ' parameter');
		process.exit(1);
	}
};

urltemplates.forEach(function (template) {
	if (!/^https?\:/.test(template)) {
		displayHelp();
		console.error('No url template provided');
		process.exit(1);
	}
	validateurlparam(template, '{x}');
	validateurlparam(template, '{y}');
	validateurlparam(template, '{z}');
});

// execute
var count_succeeded = 0;
var count_failed = 0;
var rawgeojson = '';
var t_start = (new Date()).getTime();

async.series([
	function readFromPipe(callback) {
		try {
			rawgeojson = fs.readFileSync(process.stdin.fd, 'utf8');
			if (rawgeojson.trim() == "") {
				throw new Error('invalid input');
			}
		} catch (err) {
			if (err.code !== 'EAGAIN') {
				throw err;
			}
		}
		callback();
	},
	function determineGeometry(callback) {
		if (rawgeojson) {
			geojson = JSON.parse(rawgeojson);
		} else if (argv.file) {
			geojson = JSON.parse(fs.readFileSync(argv.file, 'utf8'));
		} else if (argv.point) {
			var coords = String(argv.point).split(',').map(parseFloat);
			geojson = turf.point([coords[1], coords[0]]);
		} else if (argv.extent) {
			var coords = String(argv.extent).split(',').map(parseFloat);
			var input = turf.featureCollection([
				turf.point([coords[1], coords[0]]),
				turf.point([coords[3], coords[2]])
			]);
			geojson = turf.bboxPolygon(turf.bbox(input));
		} else if (argv.expiredlist) {
			callback();
			return true;
		} else {
			displayHelp();
			console.error('No geometry provided. Pipe geojson, or use --point / --extent / --expiredlist');
			return process.exit(1);
		}
		if (argv.buffer) {
			var radius = parseFloat(argv.buffer);
			var units = /mi$/.test(argv.buffer) ? 'miles' : 'kilometers';
			geojson = turf.buffer(geojson, radius, units);
		}
		if (!geojson.type) {
			throw new Error('Missing geometry type');
		}
		// tilecover doesn't like features
		if (geojson.type === 'FeatureCollection') {
			var merged = geojson.features[0];
			for (var i = 1; i < geojson.features.length; i++) {
				if (geojson.features[i].geometry) {
					merged = turf.union(merged, geojson.features[i]);
				}
			}
			geojson = merged;
		}
		if (geojson.type === 'Feature') {
			geojson = geojson.geometry;
		}
		callback();
	},
	function performAction(callback) {
		var headers = {};
		var urls = [];
		function asyncRequest(urls, limit, callback) {
			async.eachLimit(urls, limit, function (url, callback) {
				async.retry(argv.retries, function (callback) {
					var start = (new Date()).getTime();
					request({
						method: argv.method,
						url: url,
						headers: headers
					}, function (err, res, body) {
						if (err) return callback(err);
						var time = (new Date()).getTime() - start;
						var statuscolor = res.statusCode !== 200 ? 'red' : 'green';
						var size_data = filesize(res.body.length);
						var size_length = res.headers['content-length'] ? filesize(Number(res.headers['content-length'])) : '(no content-length)';
						process.stdout.cursorTo(0);
						console.log(chalk.gray('[') + chalk[statuscolor](res.statusCode) + chalk.grey(']') + ' ' + url + ' ' + chalk.blue(time + 'ms') + ' ' + chalk.grey(size_data + ', ' + size_length));
						bar.tick();
						if (res.statusCode !== 200) {
							count_failed++;
							callback('Request failed (non-200 status)');
						} else {
							count_succeeded++;
							callback();
						}
					});
				}, function (err) {
					if (err && argv.allowfailures) err = null;
					callback(err);
				});
			}, callback);
		}

		function buildURLs(xyz, urls) {
			urltemplates.forEach(function (template) {
				urls.push(template.replace(/\{x\}/g, xyz[0]).replace(/\{y\}/g, xyz[1]).replace(/\{z\}/g, xyz[2]));
			});
		}
		if (argv.header) {
			if (!Array.isArray(argv.header)) argv.header = [argv.header];
			argv.header.forEach(function (header) {
				var delim = header.indexOf(':');
				if (delim === -1) return;
				var key = header.substring(0, delim).trim();
				var value = header.substring(delim + 1).trim();
				headers[key] = value;
			});
		}
		if (!headers['User-Agent']) {
			headers['User-Agent'] = 'TileMantle/' + pkg.version;
		}
		if (argv.expiredlist) {
			var lineCount = 0;
			fs.createReadStream(argv.expiredlist).on('data', function (chunk) {
				for (i = 0; i < chunk.length; ++i) {
					if (chunk[i] === 10) {
						lineCount++;
					}
				}
			}).on('end', function () {
				lineCount = lineCount * urltemplates.length;
				bar = new ProgressBar(chalk.gray('[:bar] :percent (:current/:total) eta: :etas'), {
					total: lineCount,
					width: 20
				});
				var lineNumber = 0;
				var rs = fs.createReadStream(argv.expiredlist)
					.pipe(es.split())
					.pipe(es.mapSync(function (line) {
							rs.pause();
							lineNumber++;
							if (line.trim().length === 0) {
								return rs.resume();
							}
							var zxy = line.split('/');
							buildURLs([zxy[1], zxy[2], zxy[0]], urls);
							if (argv.list) {
								for (var i = 0, n = urls.length; i < n; i++) {
									console.log(urls[i]);
								}
								urls = [];
								return rs.resume();
							}
							if (urls.length > 0 && lineNumber % argv.concurrency === 0) {
								asyncRequest(urls, argv.concurrency, function (err) {
									urls = [];
									rs.resume();
								});
							} else {
								rs.resume();
							}
						})
						.on('error', function (err) {
							callback(err);
						})
						.on('end', function () {
							if (urls.length > 0) {
								asyncRequest(urls, argv.concurrency, function (err) {
									urls = [];
									callback();
								});
							} else {
								callback();
							}
						})
					);
			});
		} else {
			var zooms = [];
			if (argv.zoom.indexOf('-') > -1) {
				var parts = argv.zoom.split('-').map(Number);
				var minzoom = parts[0];
				var maxzoom = parts[1];
				if (maxzoom > minzoom) {
					for (var z = minzoom; z <= maxzoom; z++) {
						zooms.push(z);
					}
				} else {
					for (var z = minzoom; z >= maxzoom; z--) {
						zooms.push(z);
					}
				}
			} else {
				zooms = argv.zoom.split(',').map(Number);
				zooms.sort();
			}

			function buildTileList(geojson, zooms) {
				var groups = [];
				zooms.forEach(function (z) {
					groups.push(tilecover.tiles(geojson, {
						min_zoom: z,
						max_zoom: z
					}));
				});
				var result = [];
				return result.concat.apply(result, groups);
			}
			buildTileList(geojson, zooms).forEach(function (xyz) {
				return buildURLs(xyz, urls);
			});
			if (argv.list) {
				for (var i = 0, n = urls.length; i < n; i++) {
					console.log(urls[i]);
				}
				callback();
			} else {
				bar = new ProgressBar(chalk.gray('[:bar] :percent (:current/:total) eta: :etas'), {
					total: urls.length,
					width: 20
				});
				asyncRequest(urls, argv.concurrency, callback);
			}
		}
	}
], function (err) {
	if (count_succeeded || count_failed) {
		var duration = (new Date()).getTime() - t_start;
		console.log('');
		console.log(chalk.grey(numeral(count_succeeded).format('0,0') + ' succeeded, ' + numeral(count_failed).format('0,0') + ' failed after ' + humanizeDuration(duration)));
	}
	if (err) {
		console.error(chalk.red('Error: ' + (err.message || err)));
		process.exit(1);
	} else {
		process.exit(0);
	}
});
