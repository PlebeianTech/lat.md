DEFAULT_NAME = 'World'

def greet(name)
  "Hello, #{name}!"
end

module Greeting
  def wave
    'wave'
  end
end

class Greeter
  VERSION = '1.0'

  def initialize(prefix = 'Hello')
    @prefix = prefix
  end

  def greet(name)
    "#{@prefix}, #{name}!"
  end

  def self.default_greeter
    new
  end

  def valid?
    true
  end

  def save!
    true
  end

  def count=(val)
    @count = val
  end

  def ==(other)
    other.is_a?(Greeter)
  end

  def [](key)
    @prefix
  end
end

class Admin::SuperGreeter
  ADMIN_CODE = 999

  def super_greet
    'SUPER!'
  end
end
