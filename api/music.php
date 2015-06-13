<?php 
header('Content-Type: application/json;');

define('MUSICPATH', 'music');

if (isset($_GET['artists']) && $_GET['artists']) {

	function artists(){
		$verzeichnispfad = 'music';
		$artists = array_slice(scanDir(MUSICPATH), 2);
		
		$a = array();

		$a['error'] = false;
		
		for($i=0; $i < count($artists); $i++){
			if(strpos($artists[$i], '.') === false && strpos($artists[$i], ':') === false){
				$a['data'][] = array(
                    'id'	=> $i,
					'name' 	=> $artists[$i],
					'slug'  => urlencode($artists[$i])
				);
			}
		}
		
		return json_encode($a);
	}
	
	echo artists();

} elseif (isset($_GET['artist']) && $_GET['artist']) {

    $artist = $_GET['artist'];

    if (isset($_GET['songs']) && $_GET['songs']){

        $songs = array_slice(scanDir(MUSICPATH.'/'.$artist), 2);

        $a = array();

        for($i=0; $i < count($songs); $i++){
            //if(strpos($songs[$i], '.') === false && strpos($songs[$i], ':') === false){
                $a['data'][] = array(
                    'id'	=> $i,
                    'title' => basename($songs[$i],'.mp3'),
                    'slug'  => urlencode($songs[$i]),
                    'src' => "http://api.tunediver.com/music/$artist/$songs[$i]"
                );
            //}
        }

        echo json_encode($a);

    } elseif (isset($_GET['song'])&& $_GET['song']) {

        $artist = $_GET['artist'];
        $song = $_GET['song'];

        $a['data'] = array(
            'id'	=> 1,
            'title' => basename($song,'.mp3'),
            'slug'  => urlencode($song),
            'track_artist' => 'Artist',
            'lyrics' => 'This are the lyrics of the Song',
            'src' => "http://api.tunediver.com/music/$artist/$song"
        );

        echo json_encode($a);

    }else{
        $a['data'] = array(
            'name' 	=> $_GET['artist'],
            'bio'  => 'This is the bio of '. $artist,
            'country' => 'Someland'
        );

        echo json_encode($a);
    }

} elseif (isset($_GET['songs'])&& $_GET['songs']) {

} else {
	echo '{error: true; data: "Something went wrong"}';
}









// function songs(){
// 	$artists = array_slice(scanDir($verzeichnispfad), 2);
// 	$all = array();
// 	
// 	foreach ($artists as $artist){
// 		if(is_dir($verzeichnispfad.'/'.$artist)){
// 			$songs = array_slice(scanDir($verzeichnispfad.'/'.$artist), 2);
// 			$all[$artist] = $songs;
// 		}
// 	}
//     	
// 	echo json_encode($all);
// }
?>
