var request = require('request');
var cheerio = require('cheerio');

url = 'https://thepiratebay.se'

request(url, function(error, response, html){
	var realUrl = response.socket._httpMessage._header.split('\n')[1].replace('referer:', '');
	console.log(realUrl.toString());
	if(realUrl == 'host: thepiratebay.se'){
		return console.log('site down');
	}
});