var request = require('request');
var cheerio = require('cheerio');
var Table = require('cli-table');
var colors = require('colors');
var inquirer = require("inquirer");
var _ = require('lodash');
var program = require('commander');
var torrentStream = require('torrent-stream');
var ProgressBar = require('progress');
var homedir = require('homedir');

function bytesToSize(bytes, withBytes) {

    var sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    if (bytes == 0) return 'n/a';
    var i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
    if(withBytes == true){
    	return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + sizes[i];
  	} else {
  		return parseInt(bytes / Math.pow(1024, i));
  	}
};

program
	.usage('[options]')
  .description('Download torrent or magnet file')
	.option('-i, --id, <n>', 'Download by ID')
	.parse(process.argv);

var argv = program;
var idPrompt = {
	type: 'input',
	name: 'id',
	message: 'Please enter a id to download',
};

var prompts = [];

if(_.isUndefined(argv.id)){
	prompts.push(idPrompt);
}
if(prompts.length){
	inquirer.prompt(prompts, function(answers){
		Download(_.assign(argv,answers))
	});
}else{
	Download(argv);
}

function Download(argv){

	url = 'https://thepiratebay.am/torrent/'+ argv.id + '/';
	request(url, function(error, response, html){
		if(!error){
			var $ = cheerio.load(html);
			$('#detailsouterframe').filter(function(){
				
        var data = $(this);
        var magnetUri =  data.find(".download").children('a').attr('href');
        var engine = torrentStream(magnetUri, {
        	connections: 100,
        	path: homedir() + '/Downloads'
        });
        var x = 0;
        var filesize = [];
        var stream = [];
        engine.on('ready', function() {
				    engine.files.forEach(function(file) {
				        stream[x] = file.createReadStream();
				        filesize[x] = stream.length;
							  
							  x = x + 1;
				    });
				    bar = new ProgressBar(engine.torrent.name +" filesize:"+ bytesToSize(eval(engine.torrent.length), true) +' [:bar] :percent :etas', {
							    complete: '='.green,
							    incomplete: ' ',
							    clear: false,
							    width: 20,
							    total: engine.torrent.length
							  });
				});
				engine.on('download', function(piece){  
					if(typeof oldvalue != "undefined"){
						engine.swarm.downloaded = engine.swarm.downloaded - oldvalue;
					}
						if(!bar.complete){
							bar.tick(engine.swarm.downloaded);
						}
						oldvalue = engine.swarm.downloaded;
					});
				engine.on('idle', function(){
					process.exit()
				});
      })
		}
	})
}
