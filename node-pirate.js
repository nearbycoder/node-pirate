#!/usr/local/bin/node

var program = require('commander');

program
	.version('0.0.1')
	.command('search', 'Search for torrent by name and category')
	.command('download', 'Download item by Id given in search table')
	.parse(process.argv)

