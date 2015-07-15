## node-pirate

#### essential command line tool to search and download legal torrents from Pirate Bay

```npm install node-pirate -g```

##### feel free to fork or add a pull request. I am open for suggestions

 Usage: node-pirate [options] [command]


  Commands:

    search      Search for torrent by name and category
    download    Download item by Id given in search table
    help [cmd]  display help for [cmd]

  Options:

    -h, --help     output usage information
    -V, --version  output the version number


 Usage: node-pirate-search [options]

  Search for shows by title, category and filter by seeders or leachers

  Options:

    -h, --help           output usage information
    -t, --title, <n>     Search by title name
    -c, --category, <n>  Select type (movies, audio, games, app)
    -o, --order, <n>     Select order results by top seeders or leachers(s, l)

 Usage: node-pirate-download [options]

  Download torrent or magnet file

  Options:

    -h, --help     output usage information
    -i, --id, <n>  Download by ID
