CREATE TABLE `#__action_log_config` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `type_title` varchar(255) NOT NULL,
  `id_holder` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `#__users` (
  `id` int(11) NOT NULL,
  `name` varchar(255)
);
