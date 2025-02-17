/* Tracker Search Provider for Gnome Shell
 *
 * 2012 Contributors Christian Weber, Felix Schultze, Martyn Russell
 * 2014 Florian Miess
 *
 * This programm is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 3 of the License, or
 * (at your option) any later version.
 *
 * Version 1.5
 *
 * https://github.com/cewee/tracker-search
 *
 *
 * Version 1.6
 * https://github.com/hamiller/tracker-search-provider
 *
 */

const Main          = imports.ui.main;
const Clutter       = imports.gi.Clutter;
const Search        = imports.ui.search;
const Gio           = imports.gi.Gio;
const GLib          = imports.gi.GLib;
const IconGrid      = imports.ui.iconGrid;
const Util          = imports.misc.util;
const Tracker       = imports.gi.Tracker;
const St            = imports.gi.St;
const Atk           = imports.gi.Atk;
const Lang          = imports.lang;

/* let xdg-open pick the appropriate program to open/execute the file */
const DEFAULT_EXEC = 'xdg-open';
/* Limit search results, since number of displayed items is limited */
const MAX_RESULTS = 10;
const ICON_SIZE = 64;

const CategoryType = {
    FTS : 0,
    FILES : 1,
    FOLDERS : 2
};

var trackerSearchProviderFiles = null;
var trackerSearchProviderFolders = null;


const TrackerSearchProvider = new Lang.Class({
// const TrackerSearchProvider = class TrackerSearchProvider{
    Name : 'TrackerSearchProvider',

    _init : function(title, categoryType) {
        this._categoryType = categoryType;
        this._title = title;
        this.id = 'tracker-search-' + title;
        // this.appInfo = {get_name : function() {return 'tracker3 --help';},
        //                 get_icon : function() {return Gio.icon_new_for_string("/usr/share/icons/gnome/256x256/actions/system-search.png");},
        //                 get_id : function() {return this.id;}
        // };
        this.resultsMap = new Map();
    },


    _getQuery : function(terms, filetype) {
        // global.log("QUERY");
        var query = "";

        if (this._categoryType == CategoryType.FTS) {
            var terms_in_sparql = "";

            for (var i = 0; i < terms.length; i++) {
                if (terms_in_sparql.length > 0) terms_in_sparql += " ";
                terms_in_sparql += terms[i] + "*";
            }
            // Technically, the tag should really be matched
            // separately not as one phrase too.
            query += "SELECT ?urn nie:url(?urn) tracker:coalesce(nie:title(?urn), nfo:fileName(?urn)) nie:url(?parent) nfo:fileLastModified(?urn) WHERE { { ";
            if (filetype)
                query += " ?urn a nfo:" + filetype + " .";
            else
                query += " ?urn a nfo:FileDataObject .";
            query += " ?urn fts:match \"" + terms_in_sparql + "\" } UNION { ?urn nao:hasTag ?tag . FILTER (fn:contains (fn:lower-case (nao:prefLabel(?tag)), \"" + terms + "\")) }";
            query += " OPTIONAL { ?urn nfo:belongsToContainer ?parent .  ?r2 a nfo:Folder . FILTER(?r2 = ?urn). } . FILTER(!BOUND(?r2)). } ORDER BY DESC(nfo:fileLastModified(?urn)) ASC(nie:title(?urn)) OFFSET 0 LIMIT " + String(MAX_RESULTS);
            //  ?r2 a nfo:Folder . FILTER(?r2 = ?urn). } . FILTER(!BOUND(?r2) is supposed to filter out folders, but this fails for 'root' folders in which is indexed (as 'Music', 'Documents' and so on ..) - WHY?

        } else if (this._categoryType == CategoryType.FILES) {
            // TODO: Do we really want this?
        } else if (this._categoryType == CategoryType.FOLDERS) {
            query += "SELECT ?urn nie:url(?urn) tracker:coalesce(nie:title(?urn), nfo:fileName(?urn)) nie:url(?parent) nfo:fileLastModified(?urn) WHERE {";
            query += "  ?urn a nfo:Folder .";
            query += "  FILTER (fn:contains (fn:lower-case (nfo:fileName(?urn)), '" + terms + "')) .";
            query += "  ?urn nfo:belongsToContainer ?parent ;";
            query += "  tracker:available true .";
            query += "} ORDER BY DESC(nfo:fileLastModified(?urn)) DESC(nie:contentCreated(?urn)) ASC(nie:title(?urn)) OFFSET 0 LIMIT " + String(MAX_RESULTS);
        }
        return query;
    },

    _getResultMeta : function(resultId) {
        let res = this.resultsMap.get(resultId);
        let type = res.contentType;
        let name = res.name;
        let path = res.path;
        // let filename = res.filename;
        let lastMod = res.lastMod;
        // let contentType = res.contentType;
        // let prettyPath = res.prettyPath;
        return {
            'id':       resultId,
            'name':     name,
            'description' : path + " - " + lastMod,
            'createIcon' : function(size) {
                let icon = Gio.app_info_get_default_for_type(type, null).get_icon();
                return new St.Icon({ gicon: icon, 
                                     icon_size: size });
            }
        };
    },

    getResultMetas : function(resultIds, callback) {
        global.log("GET METAS");
        let metas = [];
        for (let i = 0; i < resultIds.length; i++) {
            metas.push(this._getResultMeta(resultIds[i]));
        }
        callback(metas);
    },

    activateResult : function(result) {
        var uri = String(result);
        // Action executed when clicked on result
        var f = Gio.file_new_for_uri(uri);
        var fileName = f.get_path();
        Util.spawn([DEFAULT_EXEC, fileName]);
        Main.overview.hide();
    },

    _getResultSet : function(obj, result, callback) {
        // global.log("GET RESULT SET");
        let results = [];
        var cursor = null;
        try{
            cursor = obj.query_finish(result);
            // global.log("QUERY FINISHED");
        }
        catch(e) {
            global.log("ERROR: " + e);
        }

        try {
            while (cursor != null && cursor.next(null)) {
                var urn = cursor.get_string(0)[0];
                var uri = cursor.get_string(1)[0];
                var title = cursor.get_string(2)[0];
                var parentUri = cursor.get_string(3)[0];
                var lastMod = cursor.get_string(4)[0];
                var lastMod = "Modified: " + lastMod.split('T')[0];
                var filename = decodeURI(uri.split('/').pop());
                // if file does not exist, it won't be shown
                var f = Gio.file_new_for_uri(uri);

                if(!f.query_exists(null)) {continue;}

                var path = f.get_path();
                // global.log(path);
                
                // clean up path
                var prettyPath = path.substr(0,path.length - filename.length).replace("/home/" + GLib.get_user_name() , "~");
                // contentType is an array, the index "1" set true,
                // if function is uncertain if type is the right one
                let contentType = Gio.content_type_guess(path, null);
                var newContentType = contentType[0];
                if(contentType[1]){
                    if(newContentType == "application/octet-stream") {
                        let fileInfo = Gio.file_new_for_path(path).query_info('standard::type', 0, null);
                        // for some reason 'content_type_guess' returns a wrong mime type for folders
                        if(fileInfo.get_file_type() == Gio.FileType.DIRECTORY) {
                            newContentType = "inode/directory";
                        } else {
                            // unrecognized mime-types are set to text, so that later an icon can be picked
                            newContentType = "text/x-log";
                        }
                    };
                }
                results.push(uri);
                this.resultsMap.set(uri, {
                    'id' : uri,
                    'name' : title,
                    'path' : path,
                    'filename': filename,
                    'lastMod' : lastMod,
                    'prettyPath' : prettyPath,
                    'contentType' : newContentType
                });
            }
        } catch (error) {
            global.log("TrackerSearchProvider: Could not traverse results cursor: " + error.message);
        }
        callback(results);
    },

    _connection_ready : function(object, result, terms, filetype, callback) {
        // global.log("CONN READY");
        try {
            // var conn = Tracker.SparqlConnection.new_finish(result);
            var ontology_path = Gio.file_new_for_path('.cache/tracker3/files');
            var conn = Tracker.SparqlConnection.new(Tracker.SparqlConnectionFlags.NONE, ontology_path, null, null); 
            var query = this._getQuery(terms, filetype);
            // var cursor = conn.query_async(query, null, this._getResultSet.bind(conn, result, callback));
            var cursor = conn.query_async(query, null, Lang.bind(this, this._getResultSet, callback));
        } catch (error) {
            global.log("EXCEPTION 1: Querying Tracker failed. Please make sure you have the --GObject Introspection-- package for Tracker installed.");
            global.log(error.message);
        }
    },

    getInitialResultSet : function(terms, callback, cancellable) {
        // terms holds array of search items
        // check if 1st search term is >2 letters else drop the request
        if(terms.length === 1 && terms[0].length < 3) {
            return [];
        }

        // check if search starts with keyword: m (=music), i (=images), v (=videos)
        if(terms.length > 1) {
            if(terms[1].length < 3) {
                return [];
            }
            
            if(terms[0].lastIndexOf("v",0) === 0) {
                var filetype = "Video";
            }
            if(terms[0].lastIndexOf("m",0) === 0) {
                var filetype = "Audio";
            }
            if(terms[0].lastIndexOf("i",0) === 0) {
                var filetype = "Image";
            }

        }

        try {
            // Tracker.SparqlConnection.get_async(null, Lang.bind(this, this._connection_ready, terms, filetype, callback));
            var ontology_path = Gio.file_new_for_path('.cache/tracker3/files');
            Tracker.SparqlConnection.new_async(null, null, ontology_path, null, Lang.bind(this, this._connection_ready, terms, filetype, callback));
            // global.log("INIT");
        } catch (error) {
            global.log("EXCEPTION 2: Querying Tracker failed. Please make sure you have the --GObject Introspection-- package for Tracker installed.");
            global.log(error.message);
        }
        return [];
    },

    getSubsearchResultSet : function(previousResults, terms, callback, cancellable) {
        // check if 1st search term is >2 letters else drop the request
        if(terms.length === 1 && terms[0].length < 3) {
            return [];
        }
        this.getInitialResultSet(terms, callback, cancellable);
        return [];
    },

    filterResults : function(results, max) {
        return results.slice(0, max);
    },

    launchSearch : function(terms) {
        if(terms.length > 1) {            
            // tracker-needle doesn't support file types
            terms = terms[1];   
        }
        
        let app = Gio.AppInfo.create_from_commandline("tracker3 search " + terms, null, Gio.AppInfoCreateFlags.SUPPORTS_STARTUP_NOTIFICATION);
        let context = global.create_app_launch_context(0, -1);
        app.launch([], context);
    }
});

function getMainOverviewViewSelector() {
    if ( Main.overview._overview.controls !== undefined) {
        // GS 40+
        return Main.overview._overview.controls._searchController;
    } else {
        // GS 38-
        return Main.overview.viewSelector;
    }
}


function init() {
//global.log("-------- fmi init: hier sollte die Tracker-Connection aufgebaut werden?");
}

function enable() {
    if (!trackerSearchProviderFiles) {
        trackerSearchProviderFiles = new TrackerSearchProvider("FILES", CategoryType.FTS);
        
        let _searchResults = getMainOverviewViewSelector()._searchResults

        if (_searchResults._searchSystem) {
            _searchResults._searchSystem.addProvider(trackerSearchProviderFiles);
        } else {
            _searchResults._registerProvider(trackerSearchProviderFiles);
        }

        // Main.overview.viewSelector._searchResults._registerProvider(trackerSearchProviderFiles);
    }
}

function disable() {
    if (trackerSearchProviderFiles){
        let _searchResults = getMainOverviewViewSelector()._searchResults
        if (_searchResults._searchSystem) {
            _searchResults._searchSystem._unregisterProvider(trackerSearchProviderFiles);
        } else {
            _searchResults._unregisterProvider(trackerSearchProviderFiles);
        }

        // provider._remminaMonitor.cancel();
        trackerSearchProviderFiles = null;
        // Main.overview.viewSelector._searchResults._unregisterProvider(trackerSearchProviderFiles);
        // trackerSearchProviderFiles = null;
    }
}

