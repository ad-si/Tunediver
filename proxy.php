<?php
// Stupidly simple PHP proxy for AJAX (HTTP GET) requests. Written by Kevin Lanni.

$dest = 'http://api.adriansieber.com/music.php'; // Set to the remote script URL (i.e. http://remotehost.com/some.php)

$a = array();

foreach ($_GET as $k=>$v) {
	$a[] = "{$k}={$v}";
}

echo file_get_contents($dest.'?'.implode('&',$a));
?>