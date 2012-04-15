<?php

echo file_get_contents('http://api.tunediver.com/music.php?'.$_SERVER['QUERY_STRING']);

?>