# @lat: [[lat.md/docs#Docs]]

desc 'Default task'
task default: :build

desc 'Build project'
task :build do
  puts 'building'
end

namespace :db do
  desc 'Run migrations'
  task :migrate => :environment do
    puts 'migrating'
  end
end

def rake_helper
  123
end
